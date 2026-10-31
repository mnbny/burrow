import { defineCommand, runMain } from 'citty'

import deploy from './commands/deploy.ts'
import readme from './commands/readme.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const main = defineCommand({
  meta: {
    name: 'burrow',
    description: 'Deploy static reports to burrow',
  },
  subCommands: { deploy, readme },
})

await runMain(main)
