import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

import manifest from '../../package.json' with { type: 'json' }

const repoRoot = process.cwd()
const [host] = process.argv.slice(2)
const expected = ['LICENSE', 'README.md', 'cli/burrow.bundle.mjs', 'package.json']

async function main() {
  if (host) assert.equal(new URL(host).hostname, '127.0.0.1', 'Deploy checks require the local test server.')
  const temp = mkdtempSync(join(tmpdir(), 'burrow-pack-check-'))
  try {
    // Use the release packing path so catalog references resolve. The caller builds first.
    const output = execFileSync(
      'pnpm',
      ['--config.ignore-scripts=true', 'pack', '--json', '--pack-destination', temp],
      { cwd: repoRoot, encoding: 'utf8' },
    )
    const report = JSON.parse(output) as { filename: string; files: { path: string }[] }
    assert.deepEqual(report.files.map(file => file.path).sort(), expected)
    const tarball = resolve(temp, report.filename)
    const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })) as {
      name: string
      version: string
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    assert.equal(packed.name, manifest.name)
    assert.equal(packed.version, manifest.version)
    assert.equal(Object.keys(packed.dependencies ?? {}).length, 0)
    assert.equal(Object.keys(packed.optionalDependencies ?? {}).length, 0)
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const) {
      for (const [name, version] of Object.entries(packed[section] ?? {})) {
        assert(!/^(catalog|workspace):/.test(version), `${section}.${name} has an unresolved reference: ${version}`)
      }
    }
    const license = execFileSync('tar', ['-xOf', tarball, 'package/LICENSE'], { encoding: 'utf8' })
    const bundle = execFileSync('tar', ['-xOf', tarball, 'package/cli/burrow.bundle.mjs'], { encoding: 'utf8' })
    assert.equal(license, readFileSync(join(repoRoot, 'LICENSE'), 'utf8'))
    assert(bundle.includes(license.trim()), 'Project license is missing from the standalone CLI')
    for (const dependency of ['ansis', 'citty']) {
      const notice = readFileSync(join(repoRoot, 'node_modules', dependency, 'LICENSE'), 'utf8').trim()
      assert(bundle.includes(notice), `${dependency} notice is missing from the standalone CLI`)
    }
    console.log(
      'ok: npm package contains only the CLI bundle, README, license, and manifest, with no runtime dependencies',
    )
    console.log('ok: all dependency references are resolved and bundled dependency notices are preserved')

    const dryRun = spawnSync('npm', ['publish', tarball, '--dry-run', '--ignore-scripts'], {
      cwd: temp,
      encoding: 'utf8',
    })
    // npm refuses even a dry run of an already published version.
    const alreadyPublished = dryRun.stderr.includes(
      `You cannot publish over the previously published versions: ${manifest.version}.`,
    )
    assert(dryRun.status === 0 || (dryRun.status === 1 && alreadyPublished), dryRun.stderr || dryRun.error?.message)
    assert(!dryRun.stderr.includes('auto-corrected'), dryRun.stderr)

    const work = join(temp, 'work')
    mkdirSync(work)
    writeFileSync(join(work, 'README.md'), '# This is not the packaged guide\n')
    const env = {
      ...process.env,
      npm_config_cache: join(temp, 'npm-cache'),
      npm_config_update_notifier: 'false',
      BURROW_HOST: host ?? '',
      BURROW_TOKEN: host ? 'test-token' : '',
    }
    const cli = (...args: string[]) => {
      const result = spawnSync('npx', ['--yes', '--package', tarball, 'burrow', ...args], {
        cwd: work,
        env,
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr || result.error?.message)
      return result.stdout
    }

    assert.equal(cli('--version').trim(), manifest.version)
    assert.match(cli('--help'), /deploy/)
    assert.equal(cli('readme'), readFileSync(join(repoRoot, 'README.md'), 'utf8'))
    console.log(`ok: npx runs Burrow ${manifest.version} and reads its packaged guide outside the checkout`)

    if (host) {
      const site = join(work, 'site')
      mkdirSync(site)
      writeFileSync(join(site, 'index.html'), '<h1>Published from the npm package</h1>\n')
      const args = ['deploy', site, '--project', 'package', '--slug', 'smoke']
      const url = `${host}/package/smoke/`
      assert.equal(cli(...args), `${url}\n`)
      let response = await fetch(url)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '<h1>Published from the npm package</h1>\n')
      writeFileSync(join(site, 'index.html'), '<h1>Replaced from the npm package</h1>\n')
      assert.equal(cli(...args, '--replace'), `${url}\n`)
      response = await fetch(url)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '<h1>Replaced from the npm package</h1>\n')
      console.log('ok: the packed CLI deploys and replaces through the real server, printing only the URL')
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

await main().catch((error: unknown) => {
  console.error(`pack-check: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
