// Proves src/lib/tw-merge.js behaves like the real `tailwind-merge` for every
// class this app can produce — the reason we can ship the 1KB local merger
// instead of the 27KB dependency (see src/lib/tw-merge.js for the why).
//
// It collects every Tailwind-looking token from src/, then compares the two
// implementations on:
//   * each token alone,
//   * every ORDERED PAIR of tokens (this is what cn(base, override) does),
//   * the exact multi-class strings that appear literally in the source.
// Pairs are the meaningful case: tailwind-merge resolves conflicts pairwise by
// group, so agreeing on all pairs of the app's vocabulary means agreeing on any
// combination of them.
//
// Run standalone (`npm run check:cn`) or as the first step of `npm run build`.
// A failure prints the offending pair and the two outputs; the fix is almost
// always to teach the table in tw-merge.js the family named in the diff.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { twMerge as real } from 'tailwind-merge'
import { twMerge as local } from '../src/lib/tw-merge.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

// Class-ish string literals: at least one token that looks like a Tailwind
// utility. Deliberately loose — a false positive only adds a harmless token to
// the corpus, a false negative would weaken the proof.
const UTILITY_RE = /^(-?!?)(?:[a-z0-9[\]&_>~+*.,%#=:/'"()-]+:)*(?:[a-z]+(?:-[a-z0-9[\]./%#]+)*|\[[^\]]+\])$/
const FAMILY_HINT = /^(?:-?!?)(?:.*:)?(?:flex|grid|table|block|inline|hidden|contents|static|fixed|absolute|relative|sticky|text|bg|border|rounded|ring|outline|shadow|opacity|p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|w|h|size|min|max|gap|space|items|justify|content|self|place|basis|grow|shrink|order|col|row|font|leading|tracking|indent|truncate|underline|overline|uppercase|lowercase|capitalize|italic|antialiased|whitespace|break|overflow|z|top|left|right|bottom|inset|translate|scale|rotate|transition|duration|delay|ease|animate|cursor|select|pointer|list|align|caption|object|aspect|columns|blur|backdrop|fill|stroke|divide|visible|invisible|collapse|isolate|transform|sr|decoration)\b/

function tokensFrom(text) {
  const out = new Set()
  for (const m of text.matchAll(/['"`]([^'"`\n]{2,240})['"`]/g)) {
    const value = m[1]
    if (!/[a-z]/.test(value)) continue
    const parts = value.split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    if (!parts.some((p) => FAMILY_HINT.test(p) && UTILITY_RE.test(p))) continue
    for (const p of parts) if (UTILITY_RE.test(p)) out.add(p)
  }
  return out
}

function stringsFrom(text) {
  const out = new Set()
  for (const m of text.matchAll(/['"`]([^'"`\n]{2,240})['"`]/g)) {
    const value = m[1]
    const parts = value.split(/\s+/).filter(Boolean)
    if (parts.length < 2) continue
    if (!parts.every((p) => UTILITY_RE.test(p))) continue
    if (!parts.some((p) => FAMILY_HINT.test(p))) continue
    out.add(value)
  }
  return out
}

const tokens = new Set()
const literals = new Set()
for (const file of walk(SRC)) {
  if (!/\.(ts|tsx|js|jsx|css)$/.test(file)) continue
  // The merger's own group-name table ("align-items", "font-weight", …) is not
  // app vocabulary — scraping it would test invented classes, not real ones.
  if (file.endsWith(`lib${'/'}tw-merge.js`)) continue
  const text = readFileSync(file, 'utf8')
  for (const t of tokensFrom(text)) tokens.add(t)
  for (const s of stringsFrom(text)) literals.add(s)
}

const list = [...tokens].sort()
const failures = []
function check(input) {
  const a = real(input)
  const b = local(input)
  if (a !== b && failures.length < 25) failures.push({ input, real: a, local: b })
  return a === b
}

for (const t of list) check(t)
for (const s of literals) check(s)
for (const a of list) for (const b of list) if (a !== b) check(`${a} ${b}`)
// A few triples in the shape the components actually use: base string, then two
// overrides — enough to catch a shorthand/longhand ordering bug (p-6 px-5 pt-2).
for (const s of literals) for (const b of list) check(`${s} ${b}`)

const combos = list.length * (list.length - 1) + list.length + literals.size * (list.length + 1)
if (failures.length) {
  console.error(`✗ tw-merge differs from tailwind-merge on ${failures.length}+ of ${combos} cases:\n`)
  for (const f of failures) {
    console.error(`  input : ${f.input}\n  real  : ${f.real}\n  local : ${f.local}\n`)
  }
  console.error('Teach the class family to the table in src/lib/tw-merge.js.')
  process.exit(1)
}
console.log(`✓ tw-merge matches tailwind-merge on ${combos} combinations (${list.length} tokens, ${literals.size} literal class strings)`)
