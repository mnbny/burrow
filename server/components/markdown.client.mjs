import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { gfmHeadingId } from 'marked-gfm-heading-id'

marked.use(gfmHeadingId())

const status = document.getElementById('burrow-status')
const preview = document.getElementById('burrow-preview')
const raw = document.getElementById('burrow-source')
const links = [...document.querySelectorAll('[data-view]')]
const sourceURL = new URL(location.href)
sourceURL.searchParams.delete('view')
sourceURL.searchParams.delete('download')
sourceURL.searchParams.set('raw', '1')
sourceURL.hash = ''
let sourceLoaded = false
let previewReady = false
let revision = 0

const sourcePromise = fetch(sourceURL, { headers: { Accept: 'text/plain' } }).then(async response => {
  if (!response.ok) throw new Error('Document unavailable')
  const source = await response.text()
  raw.textContent = source
  sourceLoaded = true
  return source
})

function scrollToFragment() {
  if (preview.hidden || !location.hash) return
  let id
  try {
    // DOMPurify isolates document ids and named anchors from the viewer controls.
    id = `user-content-${decodeURIComponent(location.hash.slice(1))}`
  } catch {
    return
  }
  const target = document.getElementById(id) || [...preview.querySelectorAll('a[name]')].find(a => a.name === id)
  if (target && preview.contains(target)) target.scrollIntoView()
}

async function showView() {
  const current = ++revision
  const view = new URL(location.href).searchParams.get('view') === 'raw' ? 'raw' : 'preview'
  for (const link of links) {
    if (link.dataset.view === view) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  raw.hidden = view !== 'raw'
  preview.hidden = view !== 'preview'
  status.textContent = view === 'raw' ? 'Loading document…' : 'Loading preview…'
  status.hidden = false
  try {
    const source = await sourcePromise
    if (current !== revision) return
    if (view === 'preview' && !previewReady) {
      const html = marked.parse(source.replace(/^\uFEFF/, ''), { async: false, gfm: true })
      preview.replaceChildren(
        DOMPurify.sanitize(html, {
          USE_PROFILES: { html: true },
          FORBID_TAGS: ['style', 'form'],
          FORBID_ATTR: ['style', 'class'],
          SANITIZE_NAMED_PROPS: true,
          RETURN_DOM_FRAGMENT: true,
        }),
      )
      previewReady = true
    }
    status.hidden = true
    scrollToFragment()
  } catch {
    if (current !== revision) return
    preview.hidden = true
    raw.hidden = !sourceLoaded
    status.textContent = sourceLoaded
      ? 'Preview is unavailable. The original Markdown is shown below. You can still download it.'
      : 'Could not load this document. Reload the page to try again.'
  }
}

for (const link of links) {
  link.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const url = new URL(location.href)
    const currentView = url.searchParams.get('view') === 'raw' ? 'raw' : 'preview'
    if (currentView === link.dataset.view) return
    url.searchParams.set('view', link.dataset.view)
    history.pushState(null, '', url)
    showView()
  })
}
addEventListener('popstate', showView)
addEventListener('hashchange', scrollToFragment)
preview.addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  // Clicking the current fragment again does not fire hashchange.
  if (event.target.closest?.('a[href]')?.href === location.href) scrollToFragment()
})
showView()
