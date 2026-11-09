import { createHash } from 'node:crypto'

import fontLicenses from './font-licenses.txt'
import { footer } from './footer.mjs'
import script from './markdown.client.mjs'
import template from './markdown.html'
import styles from './page.css'

const page = template.replace('/* %%STYLES%% */', '%%STYLES%%').replace('/* %%SCRIPT%% */', '%%SCRIPT%%')
const assets = { STYLES: styles, SCRIPT: script, FONT_LICENSES: fontLicenses, FOOTER: footer }
const scriptHash = createHash('sha256')
  .update(page.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace('%%SCRIPT%%', () => script))
  .digest('base64')
const policy = `script-src 'sha256-${scriptHash}'; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'self'; font-src data:; style-src 'unsafe-inline'; img-src * data:`
const escape = value =>
  value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export function markdownPage(req, res, name, search) {
  const view = search.get('view') === 'raw' ? 'raw' : 'preview'
  const link = (key, value) => {
    const params = new URLSearchParams(search)
    for (const flag of ['view', 'raw', 'download']) params.delete(flag)
    params.set(key, value)
    return escape(`?${params}`)
  }
  const values = {
    TITLE: escape(name),
    PREVIEW_URL: link('view', 'preview'),
    RAW_URL: link('view', 'raw'),
    DOWNLOAD_URL: link('download', '1'),
    PREVIEW_CURRENT: view === 'preview' ? 'aria-current="page"' : '',
    RAW_CURRENT: view === 'raw' ? 'aria-current="page"' : '',
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy })
  // Asset text can contain placeholder-like sequences; only substitute in the template.
  res.end(
    req.method === 'HEAD'
      ? undefined
      : page.replace(/%%([A-Z_]+)%%/g, (match, key) => values[key] ?? assets[key] ?? match),
  )
}
