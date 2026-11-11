import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'

import manifest from '../../package.json' with { type: 'json' }

const [host] = process.argv.slice(2)
assert(host, 'Pass the test server URL.')
const run = promisify(execFile)
const cliPath = fileURLToPath(new URL('../../cli/burrow.mjs', import.meta.url))
const bundlePath = fileURLToPath(new URL('../../cli/burrow.bundle.mjs', import.meta.url))
const composePath = fileURLToPath(new URL('./compose.yml', import.meta.url))
const token = 'test-token'
const cli = async (target, args, launcher = cliPath) => {
  const { stdout } = await run(process.execPath, [launcher, 'deploy', target, '--project', 'replacement', ...args], {
    env: { ...process.env, BURROW_HOST: host, BURROW_TOKEN: token },
  })
  return stdout.trim()
}
const metadata = async slug => {
  const { stdout } = await run('docker', [
    'compose',
    '-f',
    composePath,
    'exec',
    '-T',
    'app',
    'cat',
    `/data/replacement/${slug}/.meta.json`,
  ])
  return JSON.parse(stdout)
}
const lifetime = meta => (meta.expiresAt === null ? 0 : Date.parse(meta.expiresAt) - Date.parse(meta.deployedAt))
const day = 86_400_000
const root = `${host}/replacement/notes/`
const login = (username, password) =>
  fetch(root, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams({ username, password }),
  })
const upload = (endpoint, headers, body = '') =>
  fetch(`${host}/_deploy/${endpoint}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'x-burrow-version': manifest.version, 'x-replace': '1', ...headers },
    body,
  })
const contents = async (url, cookie) => {
  const response = await fetch(url, { headers: cookie ? { cookie } : {} })
  assert.equal(response.status, 200, `Expected readable content at ${url}`)
  return response.text()
}
const status = async (url, cookie) => {
  const response = await fetch(url, { headers: cookie ? { cookie } : {} })
  await response.body?.cancel()
  return response.status
}

const temp = await mkdtemp(path.join(tmpdir(), 'burrow-replace-'))
try {
  const first = path.join(temp, 'first')
  const second = path.join(temp, 'second')
  await mkdir(first)
  await mkdir(second)
  await writeFile(path.join(first, 'report.md'), '# First version\n')
  await writeFile(path.join(first, 'old.txt'), 'old asset')
  await writeFile(path.join(second, 'report.md'), '# Second version\n')
  await writeFile(path.join(second, 'new.txt'), 'new asset')
  // Uploaded metadata must never override the preserved settings.
  await writeFile(path.join(second, '.meta.json'), '{"auth":"attacker:password","expiresAt":null}')

  const args = ['--slug', 'notes', '--replace']
  assert.equal(await cli(first, [...args, '--auth', 'alice:secret', '--expires', '30']), root)
  const before = await metadata('notes')
  assert.equal(lifetime(before), 30 * day)
  before.deployedAt = new Date(Date.parse(before.deployedAt) - 15 * day).toISOString()
  before.expiresAt = new Date(Date.parse(before.expiresAt) - 15 * day).toISOString()
  await run('docker', [
    'compose',
    '-f',
    composePath,
    'exec',
    '-T',
    'app',
    'node',
    '-e',
    'require("node:fs").writeFileSync(process.argv[1], process.argv[2])',
    '/data/replacement/notes/.meta.json',
    JSON.stringify(before),
  ])
  const signedIn = await login('alice', 'secret')
  assert.equal(signedIn.status, 303)
  const cookie = signedIn.headers.get('set-cookie').split(';')[0]

  assert.equal(await cli(second, args), root)
  assert.equal(await status(`${root}report.md`), 401)
  assert.equal(await contents(`${root}report.md`, cookie), '# Second version\n')
  assert.equal(await status(`${root}old.txt`, cookie), 404)
  assert.equal(await contents(`${root}new.txt`, cookie), 'new asset')
  const after = await metadata('notes')
  assert.equal(after.auth, 'alice:secret')
  assert.equal(after.expiresAt, before.expiresAt, 'Omitting --expires preserves the original expiration date')
  assert(Date.parse(after.deployedAt) > Date.parse(before.deployedAt))
  console.log('ok: replacement keeps its URL, removes old files, and preserves auth, sessions, and expiration date')

  assert.equal(await cli(path.join(second, 'report.md'), args), `${root}report.md`)
  assert.equal(await status(`${root}new.txt`, cookie), 404)
  assert.equal(await contents(`${root}report.md?raw=1`, cookie), '# Second version\n')
  assert.equal(await contents(`${root}report.md?download=1`, cookie), '# Second version\n')
  assert.equal((await metadata('notes')).expiresAt, before.expiresAt)
  console.log('ok: single-file replacement replaces the entire deploy and serves updated Markdown at the same URL')

  await cli(second, [...args, '--expires', '30'])
  const renewed = await metadata('notes')
  assert.equal(lifetime(renewed), 30 * day)
  assert(Date.parse(renewed.expiresAt) > Date.parse(before.expiresAt))
  console.log('ok: an explicit --expires 30 starts a new 30-day countdown')

  await cli(first, [...args, '--auth', 'bob:new:secret', '--expires', '0'])
  assert.equal(await status(`${root}report.md`, cookie), 401)
  assert.equal((await login('alice', 'secret')).status, 401)
  assert.equal((await login('alice', 'new:secret')).status, 401)
  assert.equal((await login('bob', 'secret')).status, 401)
  const newSignIn = await login('bob', 'new:secret')
  assert.equal(newSignIn.status, 303)
  const newCookie = newSignIn.headers.get('set-cookie').split(';')[0]
  await cli(second, args)
  assert.equal((await metadata('notes')).expiresAt, null)
  assert.equal(await contents(`${root}report.md`, newCookie), '# Second version\n')
  await cli(second, [...args, '--expires', '2'])
  const overridden = await metadata('notes')
  assert.equal(overridden.auth, 'bob:new:secret')
  assert.equal(lifetime(overridden), 2 * day)
  await cli(second, [...args, '--auth', 'carol:secret'])
  assert.equal((await metadata('notes')).expiresAt, overridden.expiresAt)
  console.log(
    'ok: explicit settings override, permanent lifetime survives, and changed credentials revoke old sessions',
  )

  const other = await cli(first, ['--slug', 'notes'])
  assert.match(other, /\/replacement\/notes-[\w-]+\/$/)
  assert.equal(await contents(`${other}report.md`), '# First version\n')
  assert.equal(await status(`${root}report.md`), 401)
  assert.equal(await cli(first, ['--slug', 'New Notes', '--replace'], bundlePath), `${host}/replacement/new-notes/`)
  assert.equal(lifetime(await metadata('new-notes')), 30 * day)
  assert.equal(await contents(`${host}/replacement/new-notes/report.md`), '# First version\n')
  console.log('ok: normal deploys still take a suffix; the bundled CLI creates missing replacement slugs with defaults')

  await assert.rejects(cli(first, ['--replace']), error => /--replace requires --slug/.test(error.stderr))
  for (const auth of ['', 'alice', 'alice:', ':secret']) {
    await assert.rejects(cli(first, [...args, '--auth', auth]), error => /complete user:pass pair/.test(error.stderr))
    assert.equal((await upload('replacement/notes', { 'x-auth': auth })).status, 400)
  }
  assert.equal((await upload('replacement', {})).status, 400)
  assert.equal((await upload('replacement/notes', { 'x-expires': '-1' })).status, 400)
  assert.equal((await upload('replacement/notes', { authorization: 'Bearer wrong' })).status, 401)
  const intact = await metadata('notes')
  assert.equal((await upload('replacement/notes', {}, gzipSync('not a tar archive'))).status, 400)
  assert.deepEqual(await metadata('notes'), intact)
  assert.equal(await status(`${root}report.md`), 401)
  const currentSignIn = await login('carol', 'secret')
  assert.equal(currentSignIn.status, 303)
  const currentCookie = currentSignIn.headers.get('set-cookie').split(';')[0]
  assert.equal(await contents(`${root}report.md`, currentCookie), '# Second version\n')

  // A valid archive followed by tar failure must never reach the server.
  const bin = path.join(temp, 'bin')
  const scratch = path.join(temp, 'scratch')
  await mkdir(bin)
  await mkdir(scratch)
  const archiveEnv = {
    ...process.env,
    BURROW_HOST: host,
    BURROW_TOKEN: token,
    TMPDIR: scratch,
    // Keep the source launcher's cache out of the archive-cleanup assertion.
    TSX_DISABLE_CACHE: '1',
  }
  const { stdout: realTar } = await run('sh', ['-c', 'command -v tar'])
  await writeFile(
    path.join(bin, 'tar'),
    `#!${process.execPath}\nrequire('node:child_process').execFileSync(${JSON.stringify(realTar.trim())}, process.argv.slice(2), { stdio: 'inherit' }); process.exit(1)\n`,
    { mode: 0o700 },
  )
  for (const launcher of [cliPath, bundlePath]) {
    for (const searchPath of [`${bin}${path.delimiter}${process.env.PATH}`, scratch]) {
      await assert.rejects(
        run(process.execPath, [launcher, 'deploy', first, '--project', 'replacement', ...args], {
          env: { ...archiveEnv, PATH: searchPath },
        }),
        error => error.code === 1 && /tar/i.test(error.stderr) && error.stdout === '',
      )
      assert.deepEqual(await metadata('notes'), intact)
      assert.equal(await contents(`${root}report.md`, currentCookie), '# Second version\n')
      assert.deepEqual(await readdir(scratch), [], 'Failed archives must be cleaned up')
    }
    for (const [uploadHost, uploadToken] of [
      [host, 'wrong-token'],
      ['http://127.0.0.1:1', token],
    ]) {
      await assert.rejects(
        run(process.execPath, [launcher, 'deploy', first, '--project', 'replacement', ...args], {
          env: { ...archiveEnv, BURROW_HOST: uploadHost, BURROW_TOKEN: uploadToken },
        }),
        error => error.code === 1 && /Deploy failed|Could not upload/.test(error.stderr) && error.stdout === '',
      )
      assert.deepEqual(await metadata('notes'), intact)
      assert.deepEqual(await readdir(scratch), [], 'Failed uploads must clean up their archive')
    }
    await run(
      process.execPath,
      [launcher, 'deploy', first, '--project', 'replacement', '--slug', 'cleanup', '--replace'],
      { env: archiveEnv },
    )
    assert.deepEqual(await readdir(scratch), [], 'Successful uploads must clean up their archive')
  }
  console.log('ok: tar and upload failures preserve the live deploy; temporary archives are always removed')

  const { stdout: archive } = await run('tar', ['-cz', '-C', first, '.'], { encoding: 'buffer' })
  const interrupted = http.request(`${host}/_deploy/replacement/notes`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-burrow-version': manifest.version,
      'x-replace': '1',
      'content-length': archive.length,
    },
  })
  interrupted.on('error', () => {})
  interrupted.write(archive.subarray(0, Math.floor(archive.length / 2)))
  assert.equal(await contents(`${root}report.md`, currentCookie), '# Second version\n')
  interrupted.destroy()
  assert.deepEqual(await metadata('notes'), intact)
  console.log('ok: invalid settings, failed archives, and interrupted replacements leave the old deploy available')

  const concurrentStart = Date.now()
  const results = await Promise.all([
    cli(first, [...args, '--auth', 'latest:password', '--expires', '3']),
    cli(second, args),
  ])
  assert.deepEqual(results, [root, root])
  const concurrent = await metadata('notes')
  assert.equal(concurrent.auth, 'latest:password')
  assert(Date.parse(concurrent.expiresAt) >= concurrentStart + 3 * day)
  assert(Date.parse(concurrent.expiresAt) <= Date.now() + 3 * day)
  const concurrentSignIn = await login('latest', 'password')
  assert.equal(concurrentSignIn.status, 303)
  const concurrentCookie = concurrentSignIn.headers.get('set-cookie').split(';')[0]
  const final = await contents(`${root}report.md`, concurrentCookie)
  assert(['# First version\n', '# Second version\n'].includes(final))
  assert.equal(await status(`${root}old.txt`, concurrentCookie), final === '# First version\n' ? 200 : 404)
  assert.equal(await status(`${root}new.txt`, concurrentCookie), final === '# Second version\n' ? 200 : 404)
  console.log('ok: concurrent replacements publish complete deploys at one URL and retain the latest settings')

  const originalDownload = Buffer.alloc(8 * 1024 * 1024, 'a')
  await writeFile(path.join(first, 'large.bin'), originalDownload)
  const downloadRoot = await cli(first, ['--slug', 'download', '--replace'])
  const download = await fetch(`${downloadRoot}large.bin`)
  assert.equal(download.status, 200)
  await cli(second, ['--slug', 'download', '--replace', '--auth', 'reader:password'])
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), originalDownload)
  assert.equal(await status(`${downloadRoot}report.md`), 401)
  console.log('ok: an ongoing download finishes with its original bytes across replacement')
} finally {
  await rm(temp, { recursive: true, force: true })
}
