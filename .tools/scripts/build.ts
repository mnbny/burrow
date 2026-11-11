import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
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
      loader: { '.html': 'text', '.txt': 'text' },
      platform: 'node',
      plugins: [
        {
          name: 'viewer-assets',
          setup(builder) {
            builder.onLoad({ filter: /(\.css|\.client\.mjs)$/ }, async ({ path }) => {
              const asset = await build({
                ...(path.endsWith('.css')
                  ? {
                      stdin: {
                        contents: execFileSync('pnpm', ['exec', 'tailwindcss', '--input', path, '--minify'], {
                          cwd: repoRoot,
                          encoding: 'utf8',
                        }),
                        loader: 'css',
                        resolveDir: dirname(path),
                        sourcefile: path,
                      },
                    }
                  : { entryPoints: [path] }),
                bundle: true,
                format: 'iife',
                loader: { '.woff2': 'dataurl' },
                minify: true,
                platform: 'browser',
                target: 'es2022',
                write: false,
              })
              const [output] = asset.outputFiles
              if (!output) throw new Error(`esbuild produced no output for ${path}.`)
              return { contents: output.text, loader: 'text' }
            })
          },
        },
      ],
      target: TARGET,
      write: false,
    })

    const [output] = bundled.outputFiles

    if (!output) throw new Error(`esbuild produced no output file for ${entry}.`)

    // esbuild's own minifier rewrites an escaped newline into a template literal holding a real one,
    // which costs a byte less and breaks the bundle across a thousand lines. terser escapes instead,
    // so executable code stays on one line and a source change stays a one-line diff.
    const minified = await minify(output.text, {
      compress: true,
      format: { ascii_only: true },
      mangle: true,
      module: true,
    })

    if (!minified.code) throw new Error(`terser produced no output for ${entry}.`)

    let code = minified.code
    if (entry === join('cli', 'cli.ts')) {
      // The standalone CLI can be copied without the rest of the package.
      code += `\n/*!\n${await readFile(join(repoRoot, 'LICENSE'), 'utf8')}*/\n`
    }
    const bundlePath = join(repoRoot, out)
    await writeFile(bundlePath, code)
    console.log(`Wrote ${relative(repoRoot, bundlePath)} (${code.length} bytes).`)
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Bundle build failed: ${message}`)
  process.exitCode = 1
})
