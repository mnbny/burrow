import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'

const [publicRoot, protectedRoot] = process.argv.slice(2)
assert(publicRoot && protectedRoot, 'Pass the public and protected fixture URLs.')
const original = await readFile(new URL('./fixtures/report.md', import.meta.url))
const screenshots = process.env.BURROW_TEST_SCREENSHOTS
if (screenshots) await mkdir(screenshots, { recursive: true })

const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  const externalRequests = []
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(publicRoot).origin) return route.continue()
    externalRequests.push(route.request().url())
    return route.abort()
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const preview = page.getByRole('article', { name: 'Markdown preview' })
  const raw = page.getByLabel('Markdown source')
  const screenshot = async (name, target = page) => {
    if (screenshots)
      await target.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true, animations: 'disabled' })
  }
  const checkFooter = async target => {
    const footer = target.getByRole('contentinfo')
    assert.equal(
      await footer.getByRole('link', { name: 'Moon Bunny Inc' }).getAttribute('href'),
      'https://moonbunny.io',
    )
    assert.equal(
      await footer.getByRole('link', { name: 'Privacy' }).getAttribute('href'),
      'https://moonbunny.io/privacy',
    )
    assert.equal(await footer.getByRole('link', { name: 'Terms' }).getAttribute('href'), 'https://moonbunny.io/terms')
  }
  const downloadOriginal = async target => {
    const [download] = await Promise.all([
      target.waitForEvent('download'),
      target.getByRole('link', { name: 'Download', exact: true }).click(),
    ])
    assert.equal(download.suggestedFilename(), 'report.md')
    assert.deepEqual(await readFile(await download.path()), original)
  }

  await page.goto(`${publicRoot}report.md?ref=test`)
  await preview.getByRole('heading', { name: 'Deployment report', exact: true }).waitFor()
  assert.equal(await preview.locator('table tbody tr').count(), 3)
  assert.equal(await preview.getByRole('checkbox', { checked: true }).count(), 2)
  assert.equal(await preview.getByRole('link', { name: 'HTML page' }).getAttribute('href'), './index.html')
  await page.waitForFunction(() => {
    const image = document.querySelector('article img')
    return image?.complete && image.naturalWidth === 320
  })
  await page.evaluate(() => document.fonts.ready)
  await checkFooter(page)
  const historyLength = await page.evaluate(() => history.length)
  await page.getByRole('link', { name: 'Preview', exact: true }).click({ clickCount: 3 })
  assert.equal(await page.evaluate(() => history.length), historyLength)
  assert.equal(new URL(page.url()).searchParams.has('view'), false)
  await screenshot('preview-desktop')
  await downloadOriginal(page)
  console.log('ok: Markdown preview, relative assets, and original download')

  await page.getByRole('link', { name: 'Raw', exact: true }).click()
  await raw.waitFor({ state: 'visible' })
  await checkFooter(page)
  assert.equal(new URL(page.url()).searchParams.get('view'), 'raw')
  assert.equal(new URL(page.url()).searchParams.get('ref'), 'test')
  assert.equal(await raw.textContent(), original.toString())
  assert.equal(await preview.isVisible(), false)
  await screenshot('raw-desktop')
  await downloadOriginal(page)
  await page.goBack()
  await preview.waitFor({ state: 'visible' })
  assert.equal(new URL(page.url()).searchParams.has('view'), false)
  await page.goForward()
  await raw.waitFor({ state: 'visible' })
  await page.reload()
  await raw.waitFor({ state: 'visible' })
  await page.getByRole('status').waitFor({ state: 'hidden' })
  assert.equal(await raw.textContent(), original.toString())
  console.log('ok: raw mode, URL state, refresh, back/forward, and raw-mode download')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('link', { name: 'Preview', exact: true }).click()
  await preview.getByRole('heading', { name: 'Deployment report', exact: true }).waitFor()
  assert(await page.getByRole('link', { name: 'Download', exact: true }).isVisible())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await screenshot('preview-mobile')
  await page.getByRole('link', { name: 'Raw', exact: true }).focus()
  await page.keyboard.press('Enter')
  await raw.waitFor({ state: 'visible' })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  console.log('ok: mobile layout and keyboard navigation')

  await page.setViewportSize({ width: 640, height: 240 })
  await page.goto(`${publicRoot}sections.md#details`)
  await preview.getByRole('heading', { name: 'Section links', exact: true }).waitFor()
  const sectionIsVisible = async id => {
    await page.waitForFunction(id => {
      const target = document.getElementById(id) || document.getElementsByName(id)[0]
      if (!target) return false
      const top = target.getBoundingClientRect().top
      return top >= -1 && top < innerHeight
    }, id)
  }
  await sectionIsVisible('user-content-details')
  assert((await page.evaluate(() => scrollY)) > 0)
  for (const [name, id] of [
    ['Repeated heading', 'user-content-details-1'],
    ['Custom anchor', 'user-content-custom'],
    ['Named anchor', 'user-content-legacy'],
    ['Unicode heading', 'user-content-café'],
  ]) {
    await preview.getByRole('link', { name, exact: true }).click()
    await sectionIsVisible(id)
  }
  await page.reload()
  await sectionIsVisible('user-content-café')
  await page.goto(`${publicRoot}sections.md#%ZZ`)
  await preview.getByRole('heading', { name: 'Section links', exact: true }).waitFor()
  console.log('ok: shared fragments, repeated headings, HTML anchors, and Unicode sections')

  await page.setViewportSize({ width: 1280, height: 1000 })
  await page.goto(`${publicRoot}unsafe.md`)
  await preview.getByRole('heading', { name: 'Untrusted Markdown', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.burrowXss), undefined)
  assert.equal(
    await preview.locator('script, style, form, iframe, svg, [onerror], [onload], [style], [class]').count(),
    0,
  )
  assert.equal(await preview.locator('a[href^="javascript:"]').count(), 0)
  assert.equal(await page.locator('#burrow-source').count(), 1)
  await page.getByRole('link', { name: 'Raw', exact: true }).click()
  await raw.waitFor({ state: 'visible' })
  assert.match(await raw.textContent(), /<script>window.burrowXss = true<\/script>/)
  assert.equal(await page.evaluate(() => window.burrowXss), undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(externalRequests, [])
  console.log('ok: untrusted HTML is sanitized, source is literal, and no CDN is needed')

  const protectedContext = await browser.newContext()
  const protectedPage = await protectedContext.newPage()
  await protectedPage.goto(`${protectedRoot}report.md?view=raw`)
  await checkFooter(protectedPage)
  await protectedPage.evaluate(() => document.fonts.ready)
  await screenshot('sign-in-desktop', protectedPage)
  await protectedPage.setViewportSize({ width: 390, height: 844 })
  await screenshot('sign-in-mobile', protectedPage)
  await protectedPage.getByLabel('Username').fill('me')
  await protectedPage.getByLabel('Password').fill('secret')
  await protectedPage.getByRole('button', { name: 'Continue' }).click()
  await protectedPage.waitForURL(`${protectedRoot}report.md?view=raw`)
  await protectedPage.getByRole('status').waitFor({ state: 'hidden' })
  assert.equal(await protectedPage.getByLabel('Markdown source').textContent(), original.toString())
  await downloadOriginal(protectedPage)
  console.log('ok: signing in preserves raw mode and permits the protected download')

  const noScriptContext = await browser.newContext({ javaScriptEnabled: false })
  const noScriptPage = await noScriptContext.newPage()
  await noScriptPage.goto(`${publicRoot}report.md`)
  assert.match(await noScriptPage.locator('body').innerText(), /Enable JavaScript to view this document/)
  if (screenshots) await noScriptPage.screenshot({ path: path.join(screenshots, 'no-script.png') })
  await downloadOriginal(noScriptPage)
  console.log('ok: original download works with JavaScript disabled')
} finally {
  await browser.close()
}
