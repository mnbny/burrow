import { kebabCase } from 'change-case'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'

import fontLicenses from './components/font-licenses.txt'
import { footer } from './components/footer.mjs'
import loginScript from './components/login.client.mjs'
import loginError from './components/login-error.html'
import { markdownPage } from './components/markdown.mjs'
import styles from './components/page.css'

const ROOT = process.env.DATA_DIR || '/data'
const PORT = process.env.PORT || 8080
const TOKENS = (process.env.DEPLOY_TOKENS || '').split(',').filter(Boolean)

// When started as root, fix the data ownership and drop privileges before
// anything listens, so a volume written by an older root image keeps working
// without a manual chown.
if (process.getuid?.() === 0) {
  fs.mkdirSync(ROOT, { recursive: true })
  // -h keeps the chown from reaching through a planted symlink.
  spawnSync('chown', ['-Rh', 'node:node', ROOT])
  process.setgid('node')
  process.setuid('node')
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
}

const end = (res, code, msg) => {
  res.writeHead(code, { 'Content-Type': 'text/plain' })
  res.end(msg + '\n')
}

const SEGMENT = /^[\w-][\w.-]*$/ // a leading dot is excluded so a slug can never name a dotfile like .meta.json

const MAX_BODY = (Number(process.env.MAX_BODY_MB) || 50) * 1024 * 1024
const MAX_EXTRACTED = 10 * MAX_BODY // gzip expands, so the output needs its own cap

const readMeta = dir => JSON.parse(fs.readFileSync(path.join(dir, '.meta.json'), 'utf8'))

// Sessions are HMAC tokens under a per-boot key: stateless to verify, and a
// restart signs everyone out rather than persisting a secret anywhere.
const SECRET = randomBytes(32)
const COOKIE = 'mb_burrow'
const sessionToken = (slugKey, auth) =>
  createHmac('sha256', SECRET)
    .update(JSON.stringify([slugKey, auth]))
    .digest('base64url')

// Hashing both sides first permits a timing-safe compare of unequal lengths.
const safeEqual = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

const hasSession = (req, slugKey, auth) => {
  const token = sessionToken(slugKey, auth)
  return (req.headers.cookie || '')
    .split(/;\s*/)
    .some(c => c.startsWith(`${COOKIE}=`) && safeEqual(c.slice(COOKIE.length + 1), token))
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en" data-theme="moonbunny">
  <!-- ${fontLicenses} -->
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>Sign in · Burrow</title>
    <style>${styles}</style>
  </head>
  <body class="bg-base-100 font-sans text-base-content antialiased selection:bg-primary selection:text-primary-content">
    <div class="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 py-7 sm:px-8 sm:py-10">
      <main class="flex flex-1 items-center justify-center py-6">
        <section aria-labelledby="sign-in-title" class="w-full max-w-md border-2 border-primary p-5 sm:p-7">
          <header class="text-center sm:text-left">
            <h1 id="sign-in-title" class="font-display text-3xl leading-tight font-bold tracking-[-0.025em] sm:text-4xl">
              <span class="-mx-[0.05em] -my-[0.2em] inline-block bg-linear-to-b from-primary-gradient-from to-primary-gradient-to bg-clip-text px-[0.05em] py-[0.2em] text-transparent">Sign in</span>
            </h1>
            <p class="mt-3 text-base leading-7 text-base-content/65">This page is protected.</p>
          </header>
          <form method="post" action="" class="mt-7 grid gap-5">
            <div>
              <label for="u" class="block bg-primary px-3 py-3 font-mono text-xs font-bold tracking-[0.08em] text-primary-content uppercase sm:text-sm">Username</label>
              <input id="u" name="username" autocomplete="username" placeholder="username" required autofocus
                class="h-14 w-full min-w-0 rounded-none border-2 border-primary bg-base-100 px-4 text-base font-medium outline-none placeholder:text-base-content/45 focus:shadow-[4px_4px_0] focus:shadow-primary" />
            </div>
            <div>
              <label for="p" class="block bg-primary px-3 py-3 font-mono text-xs font-bold tracking-[0.08em] text-primary-content uppercase sm:text-sm">Password</label>
              <input id="p" name="password" type="password" autocomplete="current-password" placeholder="••••••••" required
                class="h-14 w-full min-w-0 rounded-none border-2 border-primary bg-base-100 px-4 text-base font-medium outline-none placeholder:text-base-content/45 focus:shadow-[4px_4px_0] focus:shadow-primary" />
            </div>
            <button type="submit" class="outline-button btn mt-2 mb-1 h-14 w-full text-base sm:text-lg">Continue</button>
          </form>
        </section>
      </main>
      ${footer}
    </div>
    %%ERROR%%
  </body>
</html>
`

const loginPage = (res, error) => {
  res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    LOGIN_PAGE.replace('%%ERROR%%', () => (error ? `${loginError}<script type="module">${loginScript}</script>` : '')),
  )
}

// tar refuses absolute symlinks but extracts relative ones, which would let a served
// path escape the slug; keep only directories and regular files with one hard link.
function scrub(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name)
    const stats = fs.lstatSync(file)
    if (stats.isDirectory()) scrub(file)
    else if (!stats.isFile() || stats.nlink !== 1) fs.rmSync(file, { recursive: true, force: true })
  }
}

function deploy(req, res, urlPath) {
  const token = (req.headers.authorization || '').replace('Bearer ', '')
  if (!TOKENS.includes(token)) return end(res, 401, 'bad token')

  const replace = req.headers['x-replace'] === '1'
  let project, preferred
  try {
    const [rawProject, rawSlug, extra] = urlPath.slice('/_deploy/'.length).split('/')
    if (!rawProject || extra) return end(res, 400, 'bad project/slug')
    if (replace && !rawSlug) return end(res, 400, 'replace requires a slug')
    project = kebabCase(decodeURIComponent(rawProject))
    preferred = rawSlug ? kebabCase(decodeURIComponent(rawSlug)) : randomUUID()
  } catch {
    return end(res, 400, 'bad project/slug')
  }
  if (!SEGMENT.test(project) || !SEGMENT.test(preferred)) return end(res, 400, 'bad project/slug')

  const days = req.headers['x-expires'] === undefined ? undefined : Number(req.headers['x-expires'])
  // The upper bound keeps the computed timestamp inside the valid Date range.
  if (days !== undefined && (!Number.isFinite(days) || days < 0 || days > 36_500))
    return end(res, 400, 'bad expiration')
  const auth = req.headers['x-auth']
  if (auth !== undefined && !/^[^:\r\n]+:[^\r\n]+$/.test(auth)) return end(res, 400, 'bad auth: expected user:pass')

  if (Number(req.headers['content-length']) > MAX_BODY) return end(res, 413, 'too large')

  // Extraction happens in an unservable staging directory. The existing deploy
  // stays available until the replacement and its metadata are ready.
  const staging = path.join(ROOT, '.staging', randomUUID())
  fs.mkdirSync(staging, { recursive: true })

  const fail = (code, msg) => {
    fs.rmSync(staging, { recursive: true, force: true })
    if (!res.headersSent) end(res, code, msg)
  }
  const abort = (code, msg) => {
    fail(code, msg)
    req.destroy()
    tar.kill()
  }

  // Decompression runs here rather than in tar so the decompressed size is
  // enforced while it streams, before a bomb can fill the volume.
  const gunzip = zlib.createGunzip()
  const tar = spawn('tar', ['-x', '-C', staging])
  tar.stdin.on('error', () => {})
  tar.on('error', () => abort(500, 'extract failed'))
  gunzip.on('error', () => abort(400, 'extract failed'))

  // A disconnect mid-upload never reaches tar's close event, so it needs its
  // own cleanup or the tar process and the staging dir leak.
  res.on('close', () => {
    if (res.writableFinished) return
    abort(400, 'client disconnected')
  })

  // A client can lie about content-length, so count what actually arrives.
  let received = 0
  req.on('data', chunk => {
    received += chunk.length
    if (received > MAX_BODY) abort(413, 'too large')
  })
  let extracted = 0
  gunzip.on('data', chunk => {
    extracted += chunk.length
    if (extracted > MAX_EXTRACTED) abort(413, 'extracted content too large')
  })
  req.pipe(gunzip).pipe(tar.stdin)

  tar.on('close', code => {
    try {
      if (res.headersSent) return fs.rmSync(staging, { recursive: true, force: true })
      if (code !== 0) return fail(400, 'extract failed')
      scrub(staging)

      const destination = path.join(ROOT, project, preferred)
      // Read settings at publication time so concurrent replacements inherit
      // the latest settings, rather than those present when the upload began.
      const previous = replace && fs.existsSync(destination) ? readMeta(destination) : undefined
      const now = Date.now()
      let expiresAt = days === 0 ? null : new Date(now + (days ?? 30) * 86_400_000).toISOString()
      if (days === undefined && previous) expiresAt = previous.expiresAt
      const meta = {
        deployedAt: new Date(now).toISOString(),
        expiresAt,
        requestedSlug: preferred,
      }
      const credentials = auth ?? previous?.auth
      if (credentials) meta.auth = credentials
      const metaFile = path.join(staging, '.meta.json')
      // The payload may have shipped this name, even as a directory.
      fs.rmSync(metaFile, { recursive: true, force: true })
      fs.writeFileSync(metaFile, JSON.stringify(meta))

      fs.mkdirSync(path.join(ROOT, project), { recursive: true })
      let slug = preferred
      if (previous) {
        const backup = path.join(ROOT, '.staging', randomUUID())
        // Synchronous renames cannot interleave with reads or another publish
        // in this server. Keep the old directory until the new one is in place.
        fs.renameSync(destination, backup)
        try {
          fs.renameSync(staging, destination)
        } catch (error) {
          fs.renameSync(backup, destination)
          throw error
        }
        try {
          fs.rmSync(backup, { recursive: true, force: true })
        } catch (error) {
          // Publishing succeeded; the staging sweep can retry this cleanup.
          console.error('replacement cleanup failed:', error)
        }
      } else {
        try {
          fs.renameSync(staging, destination)
        } catch (error) {
          // Only normal deploys take a suffix on collision. Replacement must
          // either publish at the requested URL or fail.
          if (replace || !['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error
          slug = `${preferred}-${randomUUID()}`
          fs.renameSync(staging, path.join(ROOT, project, slug))
        }
      }
      end(res, 200, `/${project}/${slug}/`)
    } catch {
      fail(500, 'deploy failed')
    }
  })
}

function serve(req, res, urlPath, search) {
  // Forced unless a real file sits at the data root, which no deploy can create.
  if (urlPath === '/robots.txt' && !fs.existsSync(path.join(ROOT, 'robots.txt'))) {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    return res.end('User-agent: *\nDisallow: /\n')
  }

  let parts
  try {
    parts = urlPath.split('/').map(decodeURIComponent).filter(Boolean)
  } catch {
    return end(res, 404, 'not found')
  }
  if (parts.some(p => p.startsWith('.') || p.includes('/'))) return end(res, 404, 'not found')

  if (parts.length >= 2) {
    const slugDir = path.join(ROOT, parts[0], parts[1])
    let expected
    try {
      expected = fs.existsSync(path.join(slugDir, '.meta.json')) ? readMeta(slugDir).auth : undefined
    } catch {
      // The sweep can remove the slug mid-request.
      return end(res, 404, 'not found')
    }
    if (expected && !hasSession(req, `${parts[0]}/${parts[1]}`, expected)) {
      // A navigation gets the sign-in page; an asset or script gets a bare 401.
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) return loginPage(res, false)
      return end(res, 401, 'auth required')
    }
  }

  const statOrNull = target => {
    try {
      return fs.statSync(target)
    } catch {
      return null
    }
  }

  let file = path.join(ROOT, ...parts)
  let stats = statOrNull(file)
  if (stats?.isDirectory()) {
    if (!urlPath.endsWith('/')) {
      res.writeHead(301, { Location: urlPath + '/' })
      return res.end()
    }
    file = path.join(file, 'index.html')
    stats = statOrNull(file)
  }
  if (!stats?.isFile()) return end(res, 404, 'not found')

  const extension = path.extname(file).toLowerCase()
  let contentType = MIME[extension] || 'application/octet-stream'
  if (extension === '.md' || extension === '.markdown') {
    res.setHeader('Vary', 'Accept')
    const download = search.get('download') === '1'
    const raw = search.get('raw') === '1'
    if (!download && !raw && (req.headers.accept || '').includes('text/html')) {
      return markdownPage(req, res, path.basename(file), search)
    }
    contentType = 'text/plain; charset=utf-8'
    if (download) {
      const name = encodeURIComponent(path.basename(file)).replace(
        /['()*]/g,
        c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      )
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${name}`)
    }
  }
  // Open before yielding so a replacement cannot change the file between its
  // authorization check and the stream's otherwise asynchronous open.
  const stream = req.method === 'HEAD' ? null : fs.createReadStream(file, { fd: fs.openSync(file, 'r') })
  res.writeHead(200, { 'Content-Type': contentType })
  if (!stream) return res.end()
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

function login(req, res, urlPath, search) {
  let parts
  try {
    parts = urlPath.split('/').map(decodeURIComponent).filter(Boolean)
  } catch {
    return end(res, 404, 'not found')
  }
  if (parts.length < 2 || parts.some(p => p.startsWith('.') || p.includes('/'))) return end(res, 404, 'not found')

  const slugDir = path.join(ROOT, parts[0], parts[1])
  let expected
  try {
    expected = fs.existsSync(path.join(slugDir, '.meta.json')) ? readMeta(slugDir).auth : undefined
  } catch {
    return end(res, 404, 'not found')
  }
  if (!expected) return end(res, 404, 'not found')

  let body = ''
  req.on('data', chunk => {
    body += chunk
    if (body.length > 10_000) req.destroy()
  })
  req.on('end', () => {
    try {
      const form = new URLSearchParams(body)
      const given = `${form.get('username') ?? ''}:${form.get('password') ?? ''}`
      if (!safeEqual(given, expected)) return loginPage(res, true)

      const slugKey = `${parts[0]}/${parts[1]}`
      res.writeHead(303, {
        // A single leading slash keeps redirects local for //-prefixed requests.
        Location: urlPath.replace(/^\/+/, '/') + (search.size ? `?${search}` : ''),
        'Set-Cookie': `${COOKIE}=${sessionToken(slugKey, expected)}; Path=/${slugKey}; Max-Age=2592000; HttpOnly; SameSite=Lax`,
      })
      res.end()
    } catch {
      if (!res.headersSent) end(res, 400, 'bad request')
    }
  })
}

function sweep() {
  // A staging dir left behind by a crashed deploy is garbage after a day.
  const stagingRoot = path.join(ROOT, '.staging')
  if (fs.existsSync(stagingRoot)) {
    for (const name of fs.readdirSync(stagingRoot)) {
      const dir = path.join(stagingRoot, name)
      try {
        if (fs.statSync(dir).mtimeMs < Date.now() - 86_400_000) fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // A deploy can publish or clean the entry mid-scan.
      }
    }
  }

  for (const project of fs.readdirSync(ROOT)) {
    if (project.startsWith('.')) continue
    const projectDir = path.join(ROOT, project)
    if (!fs.statSync(projectDir).isDirectory()) continue
    for (const slug of fs.readdirSync(projectDir)) {
      const slugDir = path.join(projectDir, slug)
      try {
        const { expiresAt } = readMeta(slugDir)
        if (expiresAt && Date.parse(expiresAt) < Date.now()) fs.rmSync(slugDir, { recursive: true, force: true })
      } catch {
        // A slug without readable metadata never expires.
      }
    }
    if (!fs.readdirSync(projectDir).length) fs.rmdirSync(projectDir)
  }
}

function createInterval({ intervalMs, immediate = false }, onTick) {
  let timeout
  let tickCount = 0
  let isRunning = false

  const fireTick = () => onTick({ intervalMs, tick: tickCount++, timestamp: new Date() })

  const scheduleNext = () => {
    timeout = setTimeout(() => {
      timeout = undefined
      if (!isRunning) return
      try {
        fireTick()
      } finally {
        if (isRunning) scheduleNext()
      }
    }, intervalMs)
  }

  return {
    run: () => {
      if (isRunning) return
      isRunning = true
      tickCount = 0
      if (immediate) {
        try {
          fireTick()
        } catch (error) {
          isRunning = false
          throw error
        }
      }
      if (isRunning) scheduleNext()
    },
    stop: () => {
      if (!isRunning) return
      isRunning = false
      if (timeout !== undefined) {
        clearTimeout(timeout)
        timeout = undefined
      }
    },
  }
}

createInterval({ immediate: true, intervalMs: 3_600_000 }, () => {
  try {
    sweep()
  } catch (error) {
    console.error('sweep failed:', error)
  }
}).run()

http
  .createServer((req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const urlPath = req.url.split('?')[0]
      const search = new URLSearchParams(req.url.slice(urlPath.length))
      if (req.method === 'PUT' && urlPath.startsWith('/_deploy/')) return deploy(req, res, urlPath)
      if (req.method === 'POST') return login(req, res, urlPath, search)
      if (req.method === 'GET' || req.method === 'HEAD') return serve(req, res, urlPath, search)
      end(res, 405, 'method not allowed')
    } catch (e) {
      end(res, 500, 'server error')
    }
  })
  .listen(PORT, () => {
    if (!TOKENS.length) console.warn('WARNING: DEPLOY_TOKENS empty — deploys disabled')
    console.log(`burrow on :${PORT}, serving ${ROOT}`)
  })
