import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { renderReadmeImage } from './readme-image.ts'

type Message = { speaker: string; lines: string[] }

function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function parseConversation(input: string) {
  const messages: Message[] = []
  let indent = 0

  for (const line of input.replace(/\r\n/g, '\n').split('\n')) {
    const header = /^(\S+) {2,}(.*)$/.exec(line)
    if (header) {
      const speaker = header[1]
      const content = header[2]
      if (speaker === undefined || content === undefined) throw new Error('Invalid message header.')
      indent = line.length - content.length
      messages.push({ speaker, lines: [content] })
    } else if (line.trim()) {
      const current = messages.at(-1)
      if (!current || !line.startsWith(' '.repeat(indent))) {
        throw new Error(`Expected a speaker or an indented continuation: ${line}`)
      }
      current.lines.push(line.slice(indent))
    } else {
      messages.at(-1)?.lines.push('')
    }
  }

  for (const message of messages) {
    while (message.lines.at(-1) === '') message.lines.pop()
  }
  if (!messages.length) throw new Error('The conversation is empty.')
  return messages
}

function renderHtml(messages: Message[]) {
  return messages
    .map(({ speaker, lines }) => {
      const agent = speaker === 'agent'
      const content = lines
        .map(line => {
          const escaped = escapeHtml(line)
          return agent && line.startsWith('›') ? `<span class="command">${escaped}</span>` : escaped
        })
        .join('\n')
      return `<div class="chat chat-${agent ? 'start' : 'end'}">
        <div class="chat-image avatar avatar-placeholder"><div class="avatar-circle${agent ? ' agent-avatar' : ' user-avatar'}"><span>${escapeHtml(speaker.slice(0, 1).toUpperCase())}</span></div></div>
        <div class="chat-header">${escapeHtml(speaker)}</div>
        <div class="chat-bubble${agent ? ' agent' : ' chat-bubble-primary'}">${content}</div>
      </div>`
    })
    .join('\n')
}

const STYLES = `
  .chat { container-type: inline-size; }
  .chat + .chat { margin-top: 16px; }
  .chat-image { align-self: start; }
  .avatar-circle { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; font: 700 15px/1 system-ui, sans-serif; }
  .agent-avatar { background: var(--color-neutral); color: var(--color-neutral-content); }
  .user-avatar { background: var(--color-primary); color: var(--color-primary-content); }
  .chat-header { margin: 0 3px 6px; color: var(--color-base-content); opacity: .7; font: 600 13px/1.4 system-ui, sans-serif; }
  .chat-bubble { width: 100%; max-width: 75cqi; padding: 14px 18px; font: var(--readme-font); white-space: pre-wrap; overflow-wrap: anywhere; }
  .chat-start .chat-bubble { border-start-start-radius: 0; border-end-start-radius: var(--radius-field); }
  .chat-end .chat-bubble { border-start-end-radius: 0; border-end-end-radius: var(--radius-field); }
  .chat-bubble:before { top: 0; bottom: auto; }
  .chat-start .chat-bubble:before { transform: scaleY(-1); }
  .chat-end .chat-bubble:before { transform: scale(-1, -1); }
  .chat-bubble.agent { background: var(--color-base-100); color: var(--color-base-content); }
  .command { color: var(--color-primary-content); font-weight: 700; }
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { width: { type: 'string', default: '830' }, browser: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx .tools/scripts/render-chat.ts <input.txt> <output.jpg> [--width 830] [--browser /path/to/chrome]',
    )
    return
  }
  const [input, output] = positionals
  const width = Number(values.width)
  if (!input || !output || positionals.length !== 2 || !Number.isInteger(width) || width < 240 || width > 4096) {
    throw new Error(
      'Provide an input file, an output JPEG, and a width between 240 and 4096 CSS pixels. Use --help for usage.',
    )
  }

  const messages = parseConversation(await readFile(input, 'utf8'))
  await renderReadmeImage({ content: renderHtml(messages), styles: STYLES, output, width, browserPath: values.browser })
}

await main().catch((error: unknown) => {
  console.error(`render-chat: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
