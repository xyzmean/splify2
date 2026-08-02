// Guards the contract between this build and build.sh / the LuCI loader shims.
//
// build.sh copies dist/* into the package and then rewrites `./splify-x.js?v=…`
// inside the two entry bundles to pin entry+chunk to one release. The loader
// shims (htdocs/…/view/splify/main.js and advanced.js) load splify-index.js and
// splify-settings.js by name. All three names are therefore load-bearing, and
// rollup will happily rename a shared chunk when the module graph shifts — which
// breaks the pinning silently, with no build error and a page that works until
// someone's cache serves a mismatched pair.
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
// Entries + the shared chunk + the lazily-loaded tabs. Every name here is
// load-bearing: build.sh stamps the release version into each internal reference,
// so an unexpected chunk means something is being served without cache-busting.
const EXPECTED_JS = [
  'splify-index.js', 'splify-x.js',
  'splify-OutputsPage.js', 'splify-ListsPage.js', 'splify-StatusPage.js',
]

const js = readdirSync(DIST).filter((f) => f.endsWith('.js')).sort()
const missing = EXPECTED_JS.filter((f) => !js.includes(f))
const extra = js.filter((f) => !EXPECTED_JS.includes(f))

const problems = []
if (missing.length) problems.push(`missing: ${missing.join(', ')}`)
if (extra.length) problems.push(`unexpected chunk(s): ${extra.join(', ')}`)

// Every internal chunk reference in EVERY bundle must carry the ?v= placeholder, or
// build.sh has nothing to stamp and a stale cache can pair a new entry with an old
// chunk. Checked per reference rather than for splify-x.js alone, because lazily
// loaded tabs are referenced the same way.
const seen = new Map() // chunk name -> Set of the exact specifiers used for it
for (const file of js) {
  const text = readFileSync(join(DIST, file), 'utf8')
  const refs = [...text.matchAll(/["'`](\.\/splify-[A-Za-z0-9_-]+\.js)(\?v=[^"'`]*)?["'`]/g)]
  if (!refs.length && file !== 'splify-x.js') {
    problems.push(`${file} references no chunk at all — did the build change?`)
  }
  for (const [, name, ver] of refs) {
    if (!ver) problems.push(`${file} imports ${name} without ?v= — build.sh cannot pin its version`)
    if (!seen.has(name)) seen.set(name, new Set())
    seen.get(name).add(`${name}${ver || ''}`)
  }
}

// The invariant that actually matters: one chunk, one URL, everywhere. A specifier
// differing by nothing but its query string is a DIFFERENT module to the browser,
// so a chunk referenced two ways is LOADED TWICE — and when that chunk carries
// preact/compat, the second copy has its own hook dispatcher. That shipped once:
// the entries imported "./splify-x.js?v=<ver>" while the lazily loaded tabs
// imported "./splify-x.js", and the AmneziaWG tab died on its first useState while
// every other tab worked, with nothing wrong in the ruleset, the ACL or rpcd.
for (const [name, specs] of seen) {
  if (specs.size > 1) {
    problems.push(
      `${name} is referenced ${specs.size} different ways (${[...specs].join(', ')}) — ` +
      `the browser will load it as ${specs.size} separate modules`)
  }
}

if (problems.length) {
  console.error('✗ dist layout drifted from what build.sh expects:')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\nFix the manualChunks() mapping in vite.config.ts (see its comment).')
  process.exit(1)
}
console.log(`✓ dist layout OK (${js.join(', ')})`)
