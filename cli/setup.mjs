#!/usr/bin/env node

// Keep the link outside versioned Node installations.

import { chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CI) {
  console.log('CI detected. Skipping burrow link.')
  process.exit(0)
}

// A consumer clones the repository and runs nothing else, so the default entry is the bundle, which
// needs no install. The development entry needs the repository's dependencies.
const developing = process.argv.includes('--dev')
const cliDirectory = dirname(fileURLToPath(import.meta.url))
const entry = join(cliDirectory, developing ? 'burrow.mjs' : 'burrow.bundle.mjs')
const binDir = join(homedir(), '.local', 'bin')
const link = join(binDir, 'burrow')

if (!(await lstat(entry).catch(() => null))) {
  console.error(
    `${entry} is missing. ${developing ? 'Run `pnpm build`.' : 'Re-clone, or run `pnpm install && pnpm build`.'}`,
  )
  process.exit(1)
}

await chmod(entry, 0o755)
await mkdir(binDir, { recursive: true })

const existing = await lstat(link).catch(() => null)

if (existing && !existing.isSymbolicLink()) {
  console.error(`${link} exists and is not a symlink. burrow was not linked.`)
  process.exit(0)
}

if (existing) await rm(link)
await symlink(entry, link)

console.log(`Linked burrow to ${entry}${developing ? ' (development entry)' : ''}`)

if (!(process.env.PATH ?? '').split(':').includes(binDir)) {
  console.warn(`${binDir} is not on your PATH. Add it to run burrow.`)
}
