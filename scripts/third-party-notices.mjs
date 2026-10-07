#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES.md: every open-source package that ships inside
// Suri's installer, with its licence text. Run it after changing dependencies.
//
//   npm run notices              writes the file
//   npm run notices -- --check   fails if the file is out of date (CI runs this)
//
// Which packages: the main process's dependencies (they go into app.asar) and
// what the windows' code bundles in (React, motion, Zustand, Tailwind's base
// styles), with everything those need, as package-lock.json resolves it for
// Windows x64. Electron puts its own licences next to suri.exe.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(root, 'THIRD_PARTY_NOTICES.md')
const BUNDLED_IN_WINDOWS = ['react', 'react-dom', 'motion', 'zustand', 'tailwindcss']

// Code a package carries inside its own files, which the lockfile can't see.
// unpdf's dist/pdfjs.mjs is Mozilla's pdf.js, minified, with its header gone.
// The Apache 2.0 terms are the same text TypeScript ships.
const EMBEDDED = [
  {
    name: 'pdf.js (inside unpdf)',
    version: '6.1.200',
    license: 'Apache-2.0',
    preface: 'Copyright 2012 Mozilla Foundation. https://github.com/mozilla/pdf.js',
    textFrom: 'node_modules/typescript/LICENSE.txt'
  }
]

const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** The lockfile key a package resolves to from another one, the way Node looks it up. */
function resolveKey(name, fromKey) {
  let base = fromKey
  while (base) {
    const key = `${base}/node_modules/${name}`
    if (lock.packages[key]) return key
    const cut = base.lastIndexOf('/node_modules/')
    base = cut === -1 ? '' : base.slice(0, cut)
  }
  return lock.packages[`node_modules/${name}`] ? `node_modules/${name}` : null
}

/** Optional packages built for another system (koffi has one per platform) never ship. */
function shipsOnWindows(entry) {
  return (!entry.os || entry.os.includes('win32')) && (!entry.cpu || entry.cpu.includes('x64'))
}

const seen = new Map()
const queue = [...Object.keys(pkg.dependencies), ...BUNDLED_IN_WINDOWS].map((name) =>
  resolveKey(name, '')
)
while (queue.length > 0) {
  const key = queue.shift()
  if (!key || seen.has(key)) continue
  const entry = lock.packages[key]
  if (!shipsOnWindows(entry)) continue
  seen.set(key, entry)
  const needs = [
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {})
  ]
  for (const name of needs) queue.push(resolveKey(name, key))
}

const packages = [...seen.entries()]
  .map(([key, entry]) => ({
    name: key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length),
    version: entry.version,
    license: entry.license ?? 'unknown',
    text: licenceText(join(root, key))
  }))
  .concat(
    EMBEDDED.map((e) => ({
      name: e.name,
      version: e.version,
      license: e.license,
      text: `${e.preface}\n\n${readFileSync(join(root, e.textFrom), 'utf8').replace(/\r\n/g, '\n').trim()}`
    }))
  )
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

function licenceText(dir) {
  if (!existsSync(dir)) return null
  const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.|$)/i.test(name))
  return file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : null
}

const lines = [
  '# Third-party notices',
  '',
  "Suri's installer includes these open-source packages. Electron's own licences",
  '(`LICENSE.electron.txt`, `LICENSES.chromium.html`) are next to `suri.exe`.',
  '',
  'Written by `npm run notices` from `package-lock.json`. Do not edit by hand.',
  '',
  '| Package | Version | Licence |',
  '|---|---|---|',
  ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
  ''
]
for (const p of packages) {
  lines.push(`## ${p.name} ${p.version}`, '')
  if (p.text) lines.push('~~~text', p.text, '~~~', '')
  else lines.push(`Licence: ${p.license}. The package ships no licence file.`, '')
}
const output = lines.join('\n')

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : ''
  if (current !== output) {
    console.error('THIRD_PARTY_NOTICES.md is out of date. Run: npm run notices')
    process.exit(1)
  }
  console.log(`notices: up to date (${packages.length} packages)`)
} else {
  writeFileSync(OUT, output, 'utf8')
  console.log(`notices: ${packages.length} packages written to THIRD_PARTY_NOTICES.md`)
}
