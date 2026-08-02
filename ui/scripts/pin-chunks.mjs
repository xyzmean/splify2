// Appends the cache-busting placeholder to every chunk reference in every bundle.
//
// build.sh later rewrites "?v=0.0.0" to the release version, which is what keeps a
// stale HTTP cache from pairing a new entry bundle with an old chunk. That used to
// be a one-line sed for splify-x.js only; lazily loaded tabs are imported with
// BACKTICK-quoted specifiers (`import(`./splify-WgPanel.js`)`), and a backtick
// inside an npm script breaks the shell before sed ever runs — hence a script.
//
// EVERY bundle, not just the entries: a chunk imports the shared chunk too, and a
// URL that differs by so much as the query string is a DIFFERENT module to the
// browser. When only the entries were pinned, splify-index.js imported
// "./splify-x.js?v=26.8.1.6" while splify-WgPanel.js imported "./splify-x.js" —
// so opening the AmneziaWG tab loaded a SECOND copy of preact/compat, whose hook
// dispatcher was not the one that rendered the tree, and the tab died on its first
// useState while the rest of the app worked. The invariant is not "pinned" but
// "every reference to a chunk is byte-identical everywhere"; check-dist.mjs
// enforces exactly that.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
const REF = /(["'`])(\.\/splify-[A-Za-z0-9_-]+\.js)\1/g

let pinned = 0
for (const file of readdirSync(DIST).filter((f) => f.endsWith('.js'))) {
  const path = join(DIST, file)
  const before = readFileSync(path, 'utf8')
  const after = before.replace(REF, (_m, q, name) => {
    pinned++
    return `${q}${name}?v=0.0.0${q}`
  })
  if (after !== before) writeFileSync(path, after)
}
console.log(`✓ pinned ${pinned} chunk reference(s) with ?v=`)
