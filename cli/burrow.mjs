#!/usr/bin/env node

// This file cannot be TypeScript: the shell runs it directly, so Node has to parse
// it unaided. Importing tsx by bare specifier resolves it from this file's own
// location, which is what lets the CLI run inside projects that have no tsx.

import { register } from 'tsx/esm/api'

register()

await import('./cli.ts')
