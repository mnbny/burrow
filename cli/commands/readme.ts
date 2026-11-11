import ansis from 'ansis'
import { defineCommand } from 'citty'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The dev entry and the bundle sit at different depths, so search upward.
function findReadme() {
  let dir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    const candidate = join(dir, 'README.md')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export default defineCommand({
  meta: {
    description: 'Print the full README',
    name: 'readme',
  },
  run() {
    const readme = findReadme()
    if (!readme) {
      console.error(ansis.red('The packaged README.md is missing. Reinstall Burrow or restore the checkout.'))
      process.exit(1)
    }
    process.stdout.write(readFileSync(readme, 'utf8'))
  },
})
