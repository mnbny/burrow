import ansis from 'ansis'
import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'

import manifest from '../../package.json' with { type: 'json' }

function fail(message: string): never {
  console.error(ansis.red(message))
  process.exit(1)
}

async function uploadArchive(url: string, cwd: string, entry: string, headers: Record<string, string>) {
  const temp = await mkdtemp(join(tmpdir(), 'burrow-deploy-'))
  try {
    // tar can emit a readable archive and still fail. Finish it before any
    // request can replace live files, using disk rather than buffering in RAM.
    const archive = join(temp, 'deploy.tar.gz')
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-czf', archive, '-C', cwd, '--', entry], {
        stdio: ['ignore', 'ignore', 'inherit'],
      })
      tar.once('error', error => reject(new Error(`Could not run tar: ${error.message}`)))
      tar.once('close', code => {
        if (code === 0) resolve()
        else reject(new Error('tar failed to archive the target.'))
      })
    })

    const stream = createReadStream(archive)
    try {
      return await fetch(url, {
        body: Readable.toWeb(stream) as ReadableStream,
        duplex: 'half',
        headers,
        method: 'PUT',
      }).catch((error: Error) => {
        throw new Error(`Could not upload to ${url}: ${error.message}`)
      })
    } finally {
      stream.destroy()
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

export default defineCommand({
  meta: {
    description: 'Deploy a directory or a single file to burrow',
    name: 'deploy',
  },
  args: {
    dir: { description: 'The directory or file to deploy', required: true, type: 'positional' },
    project: { description: 'First URL path segment, slugified by the server', required: true, type: 'string' },
    slug: {
      description: 'Second URL path segment, slugified by the server (default: server picks a UUID)',
      type: 'string',
    },
    replace: {
      description: 'Replace all files at --slug; keep existing auth and expiry unless supplied',
      type: 'boolean',
    },
    auth: { description: 'user:pass basic auth required to view this deploy', type: 'string' },
    expires: {
      description: 'Days from this deploy until deletion; 0 keeps it forever (new deploy default: 30)',
      type: 'string',
    },
    host: { description: 'Server URL (overrides BURROW_HOST)', type: 'string' },
    token: { description: 'Deploy token (overrides BURROW_TOKEN)', type: 'string' },
  },
  async run({ args }) {
    const host = (args.host ?? process.env['BURROW_HOST'])?.replace(/\/$/, '')
    const token = args.token ?? process.env['BURROW_TOKEN']

    if (!host) fail('Set BURROW_HOST or pass --host.')
    if (!token) fail('Set BURROW_TOKEN or pass --token.')
    if (args.replace && !args.slug) fail('--replace requires --slug.')
    if (args.auth !== undefined && !/^[^:\r\n]+:[^\r\n]+$/.test(args.auth))
      fail('--auth must be a complete user:pass pair.')

    const target = await stat(args.dir).catch(() => null)
    if (!target?.isDirectory() && !target?.isFile()) fail(`Not a directory or file: ${args.dir}`)

    const expires = args.expires === undefined ? undefined : Number(args.expires)
    if (expires !== undefined && (!Number.isFinite(expires) || expires < 0))
      fail('--expires must be a non-negative number of days.')

    // The server normalizes, defaults, and picks the final path; send the raw values.
    const project = encodeURIComponent(args.project)
    const slug = args.slug ? `/${encodeURIComponent(args.slug)}` : ''

    const [cwd, entry] = target.isDirectory() ? [args.dir, '.'] : [dirname(args.dir), basename(args.dir)]
    const response = await uploadArchive(`${host}/_deploy/${project}${slug}`, cwd, entry, {
      authorization: `Bearer ${token}`,
      'x-burrow-version': manifest.version,
      ...(args.replace ? { 'x-replace': '1' } : {}),
      ...(expires !== undefined ? { 'x-expires': String(expires) } : {}),
      ...(args.auth ? { 'x-auth': args.auth } : {}),
    }).catch((error: Error) => fail(error.message))

    const body = (await response.text()).trim()
    if (!response.ok) fail(`Deploy failed (${response.status}): ${body}`)

    const name = basename(args.dir)
    const suffix = target.isFile() && name !== 'index.html' ? encodeURIComponent(name) : ''
    // The URL is the only stdout, so a script can capture it directly.
    console.log(`${host}${body}${suffix}`)
  },
})
