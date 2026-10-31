import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { minify } from 'terser'

const repoRoot = process.cwd()

const BUNDLES = [
  { entry: join('cli', 'cli.ts'), out: join('cli', 'burrow.bundle.mjs') },
  { entry: join('server', 'server.mjs'), out: join('server', 'server.bundle.mjs') },
]

// The bundle runs where node_modules does not exist, so a dependency that ships CommonJS cannot
// reach `require`. esbuild's interop shim uses the binding when one is in scope, so the banner
// supplies it.
const BANNER = `#!/usr/bin/env node
import{createRequire as __burrowRequire}from'node:module';const require=__burrowRequire(import.meta.url);`

// Lower than the release that building this repository needs. The consumer runs the bundle on
// whatever Node the machine already has, and this is the oldest release the dependencies support.
const TARGET = 'node20'

async function main() {
  for (const { entry, out } of BUNDLES) {
    const bundled = await build({
      banner: { js: BANNER },
      bundle: true,
      entryPoints: [join(repoRoot, entry)],
      format: 'esm',
      platform: 'node',
      target: TARGET,
      write: false,
    })

    const [output] = bundled.outputFiles

    if (!output) throw new Error(`esbuild produced no output file for ${entry}.`)

    // esbuild's own minifier rewrites an escaped newline into a template literal holding a real one,
    // which costs a byte less and breaks the bundle across a thousand lines. terser escapes instead,
    // so the committed artifact stays on one line and a source change stays a one-line diff.
    const minified = await minify(output.text, {
      compress: true,
      format: { ascii_only: true },
      mangle: true,
      module: true,
    })

    if (!minified.code) throw new Error(`terser produced no output for ${entry}.`)

    const bundlePath = join(repoRoot, out)
    await writeFile(bundlePath, minified.code)
    console.log(`Wrote ${relative(repoRoot, bundlePath)} (${minified.code.length} bytes).`)
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Bundle build failed: ${message}`)
  process.exitCode = 1
})
