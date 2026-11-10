import ansis from 'ansis'
import { defineCommand } from 'citty'
import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Readable } from 'node:stream'

function fail(message: string): never {
  console.error(ansis.red(message))
  process.exit(1)
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
      description: 'Replace all files at --slug, preserving omitted auth and expiration settings',
      type: 'boolean',
    },
    auth: { description: 'user:pass basic auth required to view this deploy', type: 'string' },
    expires: {
      description: 'Days until the deploy is deleted; 0 keeps it forever (server default: 30)',
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
    const tar = spawn('tar', ['-cz', '-C', cwd, entry], { stdio: ['ignore', 'pipe', 'inherit'] })

    // The archive streams straight into the request, so a large deploy never
    // has to fit in memory.
    const response = await fetch(`${host}/_deploy/${project}${slug}`, {
      body: Readable.toWeb(tar.stdout) as ReadableStream,
      duplex: 'half',
      headers: {
        authorization: `Bearer ${token}`,
        ...(args.replace ? { 'x-replace': '1' } : {}),
        ...(expires !== undefined ? { 'x-expires': String(expires) } : {}),
        ...(args.auth ? { 'x-auth': args.auth } : {}),
      },
      method: 'PUT',
    }).catch((error: Error) => {
      if (tar.exitCode) fail('tar failed to archive the target.')
      fail(`Could not reach ${host}: ${error.message}`)
    })

    const body = (await response.text()).trim()
    if (!response.ok) fail(`Deploy failed (${response.status}): ${body}`)

    // A single non-index file serves at its own name, not the slug root.
    const name = basename(args.dir)
    const suffix = target.isFile() && name !== 'index.html' ? encodeURIComponent(name) : ''
    // The URL is the only stdout, so a script can capture it directly.
    console.log(`${host}${body}${suffix}`)
  },
})
