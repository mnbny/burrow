import { spawnSync } from 'node:child_process'
import process from 'node:process'

import manifest from '../../package.json' with { type: 'json' }

// The NAS is x86_64 and the build machine is ARM, so the platform is pinned.
const PLATFORM = 'linux/amd64'
const REPO = process.env['BURROW_IMAGE'] ?? 'ghcr.io/mnbny/burrow'

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(command: string, args: string[]) {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(result.stderr.trim())
    process.exit(1)
  }
  return result.stdout.trim()
}

run('pnpm', ['build'])

// The build runs first so a stale committed bundle also shows up as a dirty tree.
if (capture('git', ['status', '--porcelain']) !== '') {
  console.error(
    'The working tree has uncommitted changes. A release tags the commit it was built from, so commit first.',
  )
  process.exit(1)
}

const sha = capture('git', ['rev-parse', '--short', 'HEAD'])
const tags = [`${REPO}:latest`, `${REPO}:${sha}`]
// Only a named release owns the version tag; image-only commits keep their SHA tag.
if (capture('git', ['tag', '--points-at', 'HEAD', '--list', `v${manifest.version}`]))
  tags.push(`${REPO}:${manifest.version}`)

run('docker', ['buildx', 'build', '--platform', PLATFORM, ...tags.flatMap(tag => ['-t', tag]), '--push', '.'])
console.log(`Pushed ${tags.join(', ')}`)
