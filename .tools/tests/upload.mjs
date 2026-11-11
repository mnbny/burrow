// Run inside the test container so proxy buffering cannot hide early publication.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const host = 'http://127.0.0.1:8080'
const endpoint = `${host}/_deploy/uploads/trailer`
const destination = '/data/uploads/trailer'
const headers = {
  authorization: 'Bearer test-token',
  'x-burrow-version': process.argv[2],
  'x-replace': '1',
}
const metadata = () => readFileSync(`${destination}/.meta.json`, 'utf8')
const contents = () => readFileSync(`${destination}/index.html`, 'utf8')
const temp = mkdtempSync(path.join(tmpdir(), 'burrow-upload-'))
const archive = text => {
  writeFileSync(path.join(temp, 'index.html'), text)
  return execFileSync('tar', ['-cz', '-C', temp, 'index.html'])
}
const cleaned = async () => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!readdirSync('/data/.staging').length) return
    await delay(20)
  }
  assert.fail('Upload left staging files behind')
}

try {
  const original = await fetch(endpoint, {
    method: 'PUT',
    headers: { ...headers, 'x-auth': 'reader:secret', 'x-expires': '30' },
    body: archive('original'),
  })
  assert.equal(original.status, 200)
  await original.text()
  const before = metadata()
  const replacement = archive('replacement')
  const unchanged = () => {
    assert.equal(metadata(), before, 'Incomplete upload changed metadata')
    assert.equal(contents(), 'original', 'Incomplete upload replaced the live files')
  }

  for (const prefix of [replacement.subarray(0, -8), replacement]) {
    let responded = false
    const request = http.request(
      endpoint,
      {
        method: 'PUT',
        headers: { ...headers, 'content-length': replacement.length + (prefix === replacement ? 1 : 0) },
      },
      response => {
        responded = true
        response.resume()
      },
    )
    request.on('error', () => {})
    try {
      await new Promise(resolve => request.write(prefix, resolve))
      await delay(300)
      unchanged()
      assert.equal(responded, false, 'Server replied before the request finished')
    } finally {
      request.destroy()
    }
    await cleaned()
    unchanged()
  }
  console.log('ok: disconnects near the gzip trailer and after gzip completion preserve the live deploy')

  const corrupt = Buffer.from(replacement)
  corrupt[corrupt.length - 8] ^= 1
  for (const body of [replacement.subarray(0, -8), corrupt]) {
    const response = await fetch(endpoint, { method: 'PUT', headers, body })
    assert.equal(response.status, 400)
    await response.text()
    await cleaned()
    unchanged()
  }
  console.log('ok: missing and corrupt gzip trailers fail without changing files or metadata')

  const request = http.request(endpoint, {
    method: 'PUT',
    headers: { ...headers, 'content-length': replacement.length },
  })
  request.setTimeout(5000, () => request.destroy(new Error('Timed out waiting for upload completion')))
  const completed = new Promise((resolve, reject) => {
    request.on('error', reject)
    request.on('response', response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
  })
  try {
    request.write(replacement.subarray(0, -8))
    await delay(300)
    unchanged()
    request.end(replacement.subarray(-8))
    assert.equal(await completed, 200)
  } finally {
    request.destroy()
    await completed.catch(() => {})
  }
  assert.equal(contents(), 'replacement')
  const after = JSON.parse(metadata())
  assert.equal(after.auth, JSON.parse(before).auth)
  assert.equal(after.expiresAt, JSON.parse(before).expiresAt)
  await cleaned()
  console.log('ok: a delayed valid trailer publishes only after completion and retains settings')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
