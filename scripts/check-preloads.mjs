#!/usr/bin/env node
// Runs after `electron-vite build`. A sandboxed preload can only require
// `electron`: it can't load a shared chunk or an npm package, and if it tries,
// its window silently gets no API. This fails the build instead (ADR-014).

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out', 'preload')
const problems = []

for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isFile()) {
    problems.push(`${entry.name}/ is a shared chunk folder`)
    continue
  }
  const code = readFileSync(join(dir, entry.name), 'utf8')
  for (const [, name] of code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)) {
    if (name !== 'electron') problems.push(`${entry.name} requires "${name}"`)
  }
}

if (problems.length > 0) {
  console.error(`Sandboxed preloads may only require "electron":\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
console.log('preloads: self-contained')
