import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import sharp from 'sharp'

export async function renderReadmeImage(options: {
  content: string
  styles: string
  output: string
  width: number
  browserPath?: string | undefined
}) {
  const components = await readFile(fileURLToPath(import.meta.resolve('daisyui/daisyui.css')), 'utf8')
  const html = `<!doctype html>
<html lang="en" data-theme="burrow">
<head>
<meta charset="utf-8">
<style>
  ${components}
  [data-theme="burrow"] {
    color-scheme: dark;
    --color-base-100: #0a1311;
    --color-base-200: #050a09;
    --color-base-300: #0c1715;
    --color-base-content: #b4c9bf;
    --color-primary: #0d1916;
    --color-primary-content: #a6dcc7;
    --color-neutral: #0c1715;
    --color-neutral-content: #9bb7a9;
    --radius-field: .5rem;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--color-base-200); color: var(--color-base-content); --readme-font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  main { padding: 30px 32px; }
  ${options.styles}
</style>
</head>
<body><main>${options.content}</main></body>
</html>`
  const browser = await chromium.launch(options.browserPath ? { executablePath: options.browserPath } : {})
  try {
    const page = await browser.newPage({
      viewport: { width: options.width, height: 600 },
      deviceScaleFactor: 1024 / options.width,
    })
    await page.setContent(html, { waitUntil: 'load' })
    const screenshot = await page.locator('main').screenshot({ animations: 'disabled' })
    await sharp(screenshot).jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(options.output)
  } finally {
    await browser.close()
  }
  console.log(`Wrote ${options.output} at 1024 pixels wide.`)
}
