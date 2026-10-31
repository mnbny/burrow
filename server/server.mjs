import { kebabCase } from 'change-case'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'

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
const sessionToken = slugKey => createHmac('sha256', SECRET).update(slugKey).digest('base64url')

// Hashing both sides first permits a timing-safe compare of unequal lengths.
const safeEqual = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())

const hasSession = (req, slugKey) => {
  const token = sessionToken(slugKey)
  return (req.headers.cookie || '')
    .split(/;\s*/)
    .some(c => c.startsWith(`${COOKIE}=`) && safeEqual(c.slice(COOKIE.length + 1), token))
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in</title>
    <style>
      :root { --bg: #0a0b0e; --card: rgba(255,255,255,0.03); --border: rgba(255,255,255,0.08); --text: #e8eaf0; --muted: #71768a; --accent: #a7b4ff; --accent-strong: #7d8fff; }
      * { box-sizing: border-box; margin: 0; }
      body { min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; overflow: hidden; }
      body::before { content: ''; position: fixed; inset: 0; background: radial-gradient(600px 420px at 70% 18%, rgba(125,143,255,0.14), transparent 60%), radial-gradient(900px 600px at 25% 85%, rgba(125,143,255,0.06), transparent 60%); pointer-events: none; }
      main { width: min(360px, calc(100vw - 48px)); animation: rise 0.5s cubic-bezier(0.2,0.9,0.3,1) both; }
      @keyframes rise { from { opacity: 0; transform: translateY(14px); } }
      .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 36px 32px 32px; backdrop-filter: blur(20px); box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
      h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.01em; }
      p.sub { color: var(--muted); font-size: 13px; margin-top: 4px; }
      p.error { color: #ff9d9d; font-size: 13px; margin-top: 16px; }
      form { margin-top: 28px; display: grid; gap: 14px; }
      label { display: block; font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
      input { width: 100%; padding: 11px 14px; font: inherit; color: var(--text); background: rgba(255,255,255,0.04); border: 1px solid var(--border); border-radius: 10px; outline: none; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s; }
      input::placeholder { color: #4a4f63; }
      input:focus { border-color: var(--accent-strong); background: rgba(255,255,255,0.06); box-shadow: 0 0 0 3px rgba(125,143,255,0.18); }
      button { margin-top: 10px; padding: 12px; font: inherit; font-weight: 600; color: #0a0b0e; background: linear-gradient(180deg, var(--accent), var(--accent-strong)); border: 0; border-radius: 10px; cursor: pointer; transition: transform 0.12s, box-shadow 0.12s, filter 0.12s; }
      button:hover { filter: brightness(1.06); box-shadow: 0 6px 24px rgba(125,143,255,0.3); }
      button:active { transform: translateY(1px); }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <h1>Sign in</h1>
        <p class="sub">This page is protected.</p>%%ERROR%%
        <form method="post" action="">
          <div>
            <label for="u">Username</label>
            <input id="u" name="username" autocomplete="username" placeholder="username" required autofocus />
          </div>
          <div>
            <label for="p">Password</label>
            <input id="p" name="password" type="password" autocomplete="current-password" placeholder="&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;&#8226;" required />
          </div>
          <button type="submit">Continue</button>
        </form>
      </div>
    </main>
  </body>
</html>
`

const loginPage = (res, error) => {
  res.writeHead(401, { 'Content-Type': 'text/html' })
  res.end(LOGIN_PAGE.replace('%%ERROR%%', error ? '\n        <p class="error">Wrong username or password.</p>' : ''))
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

  let project, preferred
  try {
    const [rawProject, rawSlug, extra] = urlPath.slice('/_deploy/'.length).split('/')
    if (!rawProject || extra) return end(res, 400, 'bad project/slug')
    project = kebabCase(decodeURIComponent(rawProject))
    preferred = rawSlug ? kebabCase(decodeURIComponent(rawSlug)) : randomUUID()
  } catch {
    return end(res, 400, 'bad project/slug')
  }
  if (!SEGMENT.test(project) || !SEGMENT.test(preferred)) return end(res, 400, 'bad project/slug')

  const days = Number(req.headers['x-expires'] ?? 30)
  // The upper bound keeps the computed timestamp inside the valid Date range.
  if (!Number.isFinite(days) || days < 0 || days > 36_500) return end(res, 400, 'bad expiration')

  if (Number(req.headers['content-length']) > MAX_BODY) return end(res, 413, 'too large')

  // Extraction happens in an unservable staging directory and publishing is one
  // atomic rename, so a partial or unauthenticated deploy is never visible.
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

      const meta = {
        deployedAt: new Date().toISOString(),
        expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
        requestedSlug: preferred,
      }
      const auth = req.headers['x-auth']
      if (auth) meta.auth = auth
      const metaFile = path.join(staging, '.meta.json')
      // The payload may have shipped this name, even as a directory.
      fs.rmSync(metaFile, { recursive: true, force: true })
      fs.writeFileSync(metaFile, JSON.stringify(meta))

      // The rename fails on a non-empty target, which makes it the atomic
      // "slug is taken" check; deploys are immutable, so take a suffix instead.
      fs.mkdirSync(path.join(ROOT, project), { recursive: true })
      let slug = preferred
      try {
        fs.renameSync(staging, path.join(ROOT, project, slug))
      } catch {
        slug = `${preferred}-${randomUUID()}`
        fs.renameSync(staging, path.join(ROOT, project, slug))
      }
      end(res, 200, `/${project}/${slug}/`)
    } catch {
      fail(500, 'deploy failed')
    }
  })
}

function serve(req, res, urlPath) {
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
    if (expected && !hasSession(req, `${parts[0]}/${parts[1]}`)) {
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

  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
  if (req.method === 'HEAD') return res.end()
  const stream = fs.createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

function login(req, res, urlPath) {
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
        Location: urlPath,
        'Set-Cookie': `${COOKIE}=${sessionToken(slugKey)}; Path=/${slugKey}; Max-Age=2592000; HttpOnly; SameSite=Lax`,
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
      if (req.method === 'PUT' && urlPath.startsWith('/_deploy/')) return deploy(req, res, urlPath)
      if (req.method === 'POST') return login(req, res, urlPath)
      if (req.method === 'GET' || req.method === 'HEAD') return serve(req, res, urlPath)
      end(res, 405, 'method not allowed')
    } catch (e) {
      end(res, 500, 'server error')
    }
  })
  .listen(PORT, () => {
    if (!TOKENS.length) console.warn('WARNING: DEPLOY_TOKENS empty — deploys disabled')
    console.log(`burrow on :${PORT}, serving ${ROOT}`)
  })
