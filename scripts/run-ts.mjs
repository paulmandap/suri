#!/usr/bin/env node
// Runs a TypeScript file that exports `main(args)`, with the project's
// `@shared` alias, through Vite's module runner. Vite is already a dependency,
// so there's no ts-node or tsx to install. Used by `npm run eval:risk`.
//
//   node scripts/run-ts.mjs evals/run-risk-eval.ts --models qwen3.5:9b

import { resolve } from 'node:path'
import { runnerImport } from 'vite'

const [entry, ...args] = process.argv.slice(2)
if (!entry) {
  console.error('Usage: node scripts/run-ts.mjs <file.ts> [args…]')
  process.exit(1)
}

const { module } = await runnerImport(resolve(entry), {
  configFile: false,
  resolve: { alias: { '@shared': resolve('src/shared') } },
  logLevel: 'error'
})
if (typeof module.main !== 'function') {
  console.error(`${entry} has no exported main(args).`)
  process.exit(1)
}
await module.main(args)
