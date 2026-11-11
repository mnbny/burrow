import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const [host] = process.argv.slice(2)
assert(host, 'Pass the test server URL.')
const run = promisify(execFile)
const compose = fileURLToPath(new URL('./compose.yml', import.meta.url))
const root = `${host}/compatibility/site/`
const upload = (version, body, token = 'test-token') =>
  fetch(`${host}/_deploy/compatibility/site`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      ...(version === undefined ? {} : { 'x-burrow-version': version }),
      'x-replace': '1',
    },
    body,
  })
const state = async () => {
  const { stdout } = await run('docker', [
    'compose',
    '-f',
    compose,
    'exec',
    '-T',
    'app',
    'node',
    '-e',
    `const fs = require('node:fs'); console.log(JSON.stringify({
      metadata: fs.readFileSync('/data/compatibility/site/.meta.json', 'utf8'),
      staging: fs.readdirSync('/data/.staging')
    }))`,
  ])
  return JSON.parse(stdout)
}

const temp = await mkdtemp(path.join(tmpdir(), 'burrow-compatibility-'))
try {
  await writeFile(path.join(temp, 'index.html'), '<h1>Original deploy</h1>\n')
  const { stdout: archive } = await run('tar', ['-cz', '-C', temp, '.'], { encoding: 'buffer' })
  const initial = await upload('0.1.0', archive)
  assert.equal(initial.status, 200)
  assert.equal((await initial.text()).trim(), '/compatibility/site/')
  const before = await state()

  for (const version of [undefined, '', 'invalid', '0.1', '0.01.0', '0.0.99', '0.1.0-rc.1', '0.1.0, 0.1.0']) {
    // A version rejection must win over archive parsing and leave the deploy untouched.
    const response = await upload(version, 'not an archive')
    assert.equal(response.status, 400, `Expected rejection for ${String(version)}`)
    assert.match(await response.text(), /requires Burrow CLI 0\.1\.0 or newer/)
  }
  assert.deepEqual(await state(), before)
  assert.equal(await (await fetch(root)).text(), '<h1>Original deploy</h1>\n')
  console.log(
    'ok: missing, invalid, older, and prerelease CLI versions are rejected before extraction without changing the deploy',
  )

  const unauthorized = await upload('0.0.0', 'not an archive', 'wrong-token')
  assert.equal(unauthorized.status, 401)
  assert.equal((await unauthorized.text()).trim(), 'bad token')

  for (const version of ['0.1.0+build.5', '0.2.0', '0.10.0', '1.0.0']) {
    const response = await upload(version, archive)
    assert.equal(response.status, 200, `Expected acceptance for ${version}`)
    assert.equal((await response.text()).trim(), '/compatibility/site/')
  }
  console.log('ok: the minimum and newer CLI versions deploy, using semantic version ordering')
} finally {
  await rm(temp, { recursive: true, force: true })
}
