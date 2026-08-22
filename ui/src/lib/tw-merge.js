// Minimal Tailwind class merger — the 27KB `tailwind-merge` dependency, reduced
// to the utility families this app actually uses.
//
// WHY NOT JUST DROP THE MERGE: the dashboard leans on "later class wins" in
// places where the generated stylesheet says otherwise. `.w-full` is emitted
// AFTER `.w-32` in the Tailwind output, so `cn(field /* w-full */, 'w-32')` —
// how every narrow input on the settings page is built — renders full-width
// without a merge step. Same story for a variant's `bg-primary` under a call
// site's `bg-transparent`.
//
// WHY NOT KEEP tailwind-merge: it ships a complete class-group table for all of
// Tailwind (~27KB minified, measured against this bundle) and uhttpd serves the
// bundle UNCOMPRESSED, so every router client pays those bytes on a page whose
// whole vocabulary is ~250 distinct classes.
//
// CORRECTNESS: scripts/cn-equivalence.mjs extracts every class token appearing
// in src/ and asserts this function agrees with real tailwind-merge on all
// single tokens, all ordered pairs and a set of triples drawn from the source.
// It runs as part of `npm run build`, so a class from a family this table does
// not know about fails the build instead of silently changing the layout. When
// that happens, add the family below (the failure message names the token).

// ---- font sizes vs colours ---------------------------------------------------
// `text-sm` and `text-success` are different CSS properties that share a prefix,
// so the group has to be decided by the VALUE, not the prefix.
const FONT_SIZES = new Set([
  'xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl',
])
const TEXT_ALIGN = new Set(['left', 'center', 'right', 'justify', 'start', 'end'])
const FONT_WEIGHTS = new Set([
  'thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black',
])
const FONT_FAMILIES = new Set(['sans', 'serif', 'mono'])
const BORDER_STYLES = new Set(['solid', 'dashed', 'dotted', 'double', 'hidden', 'none'])
const DISPLAY = new Set([
  'block', 'inline-block', 'inline', 'flex', 'inline-flex', 'table', 'inline-table',
  'grid', 'inline-grid', 'contents', 'hidden', 'flow-root', 'list-item',
])
const POSITION = new Set(['static', 'fixed', 'absolute', 'relative', 'sticky'])
const FLEX_DIRECTION = new Set(['row', 'row-reverse', 'col', 'col-reverse'])
const FLEX_WRAP = new Set(['wrap', 'wrap-reverse', 'nowrap'])
const OVERFLOW_VALUES = new Set(['auto', 'hidden', 'clip', 'visible', 'scroll'])
const WHITESPACE = new Set(['normal', 'nowrap', 'pre', 'pre-line', 'pre-wrap', 'break-spaces'])
// `break-words` и родня — семейство word-break/overflow-wrap. Отдельным набором, а не по
// приставке `break-`, потому что ту же приставку носят классы разрыва страницы
// (break-before-*, break-inside-*, break-after-*), а это другое свойство CSS: свалив их в
// одну группу, мы бы дали последнему затирать первое без всякой на то причины.
const WORD_BREAK = new Set(['normal', 'words', 'all', 'keep'])
const SHADOW_SIZES = new Set(['sm', 'md', 'lg', 'xl', '2xl', 'inner', 'none', ''])

// A value is "sizey" (width/spacing/etc.) rather than a colour when it is a
// number, a fraction, an arbitrary value, or one of the keyword sizes.
const SIZE_KEYWORDS = new Set(['auto', 'full', 'screen', 'min', 'max', 'fit', 'px', 'svh', 'lvh', 'dvh'])
function isSizeValue(v) {
  if (v === '') return true                       // bare `border`, `rounded`, `p`… n/a but harmless
  if (v.startsWith('[')) return true              // arbitrary: w-[200px], min-h-[90px]
  if (SIZE_KEYWORDS.has(v)) return true
  return /^\d+(\.\d+)?(\/\d+)?$/.test(v)          // 4, 2.5, 1/2
}

// Prefixes whose group depends only on the prefix. Order matters: the LONGEST
// matching prefix wins, so `min-w-` is tried before `w-`.
const SIMPLE_PREFIXES = [
  ['min-w-', 'min-w'], ['max-w-', 'max-w'], ['w-', 'w'],
  ['min-h-', 'min-h'], ['max-h-', 'max-h'], ['h-', 'h'],
  ['size-', 'size'],
  ['px-', 'px'], ['py-', 'py'], ['pt-', 'pt'], ['pr-', 'pr'], ['pb-', 'pb'], ['pl-', 'pl'], ['ps-', 'ps'], ['pe-', 'pe'], ['p-', 'p'],
  ['mx-', 'mx'], ['my-', 'my'], ['mt-', 'mt'], ['mr-', 'mr'], ['mb-', 'mb'], ['ml-', 'ml'], ['ms-', 'ms'], ['me-', 'me'], ['m-', 'm'],
  ['space-x-', 'space-x'], ['space-y-', 'space-y'],
  ['gap-x-', 'gap-x'], ['gap-y-', 'gap-y'], ['gap-', 'gap'],
  ['inset-x-', 'inset-x'], ['inset-y-', 'inset-y'], ['inset-', 'inset'],
  ['top-', 'top'], ['right-', 'right'], ['bottom-', 'bottom'], ['left-', 'left'],
  ['grid-cols-', 'grid-cols'], ['grid-rows-', 'grid-rows'],
  ['col-span-', 'col-span'], ['col-start-', 'col-start'], ['col-end-', 'col-end'],
  ['row-span-', 'row-span'], ['order-', 'order'],
  ['items-', 'align-items'], ['justify-', 'justify-content'], ['content-', 'align-content'],
  ['self-', 'align-self'], ['place-items-', 'place-items'],
  ['basis-', 'basis'], ['grow-', 'grow'], ['shrink-', 'shrink'],
  ['leading-', 'leading'], ['tracking-', 'tracking'], ['indent-', 'indent'],
  ['bg-', 'bg-color'],
  ['fill-', 'fill'],
  ['rounded-t-', 'rounded-t'], ['rounded-r-', 'rounded-r'], ['rounded-b-', 'rounded-b'], ['rounded-l-', 'rounded-l'],
  ['rounded-tl-', 'rounded-tl'], ['rounded-tr-', 'rounded-tr'], ['rounded-br-', 'rounded-br'], ['rounded-bl-', 'rounded-bl'],
  ['rounded-', 'rounded'],
  ['opacity-', 'opacity'], ['z-', 'z'],
  ['duration-', 'duration'], ['delay-', 'delay'], ['ease-', 'ease'],
  ['transition-', 'transition'], ['animate-', 'animate'],
  ['cursor-', 'cursor'], ['select-', 'select'], ['pointer-events-', 'pointer-events'],
  ['translate-x-', 'translate-x'], ['translate-y-', 'translate-y'],
  ['scale-x-', 'scale-x'], ['scale-y-', 'scale-y'], ['scale-', 'scale'], ['rotate-', 'rotate'],
  ['underline-offset-', 'underline-offset'], ['decoration-', 'decoration'],
  ['list-', 'list-style-type'], ['align-', 'vertical-align'], ['caption-', 'caption'],
  ['table-', 'table-layout'], ['border-collapse', 'border-collapse'],
  ['object-', 'object'], ['aspect-', 'aspect'], ['columns-', 'columns'],
  ['backdrop-blur-', 'backdrop-blur'], ['blur-', 'blur'],
]

// Exact class names that form their own single-valued group.
const EXACT = new Map([
  ['truncate', 'text-overflow'], ['text-ellipsis', 'text-overflow'], ['text-clip', 'text-overflow'],
  ['underline', 'text-decoration'], ['overline', 'text-decoration'],
  ['line-through', 'text-decoration'], ['no-underline', 'text-decoration'],
  ['uppercase', 'text-transform'], ['lowercase', 'text-transform'],
  ['capitalize', 'text-transform'], ['normal-case', 'text-transform'],
  ['italic', 'font-style'], ['not-italic', 'font-style'],
  ['antialiased', 'font-smoothing'], ['subpixel-antialiased', 'font-smoothing'],
  ['flex-1', 'flex'], ['flex-auto', 'flex'], ['flex-initial', 'flex'], ['flex-none', 'flex'],
  ['grow', 'grow'], ['shrink', 'shrink'],
  ['border', 'border-w'], ['border-x', 'border-w-x'], ['border-y', 'border-w-y'],
  ['border-t', 'border-w-t'], ['border-r', 'border-w-r'],
  ['border-b', 'border-w-b'], ['border-l', 'border-w-l'],
  ['rounded', 'rounded'], ['shadow', 'shadow'], ['ring', 'ring'], ['outline', 'outline'],
  ['transition', 'transition'], ['transform', 'transform'],
  ['visible', 'visibility'], ['invisible', 'visibility'], ['collapse', 'visibility'],
  ['isolate', 'isolation'], ['isolation-auto', 'isolation'],
  ['overflow-auto', 'overflow'], ['sr-only', 'sr'], ['not-sr-only', 'sr'],
])

// Groups a later class also overrides. Mirrors tailwind-merge's
// conflictingClassGroups for the families above: a shorthand kills the
// longhands it subsumes, never the other way round.
const ALSO_OVERRIDES = {
  p: ['px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe'],
  px: ['pr', 'pl'], py: ['pt', 'pb'],
  m: ['mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me'],
  mx: ['mr', 'ml'], my: ['mt', 'mb'],
  gap: ['gap-x', 'gap-y'],
  inset: ['inset-x', 'inset-y', 'top', 'right', 'bottom', 'left'],
  'inset-x': ['right', 'left'], 'inset-y': ['top', 'bottom'],
  size: ['w', 'h'],
  // Tailwind's font-size utilities also set a default line-height, so a later
  // `text-sm` genuinely replaces an earlier `leading-tight`.
  'font-size': ['leading'],
  // `flex-1` is the flex SHORTHAND (grow+shrink+basis), so it replaces earlier
  // shrink-0 / grow / basis-* the same way `p-*` replaces `px-*`.
  flex: ['grow', 'shrink', 'basis'],
  rounded: ['rounded-t', 'rounded-r', 'rounded-b', 'rounded-l', 'rounded-tl', 'rounded-tr', 'rounded-br', 'rounded-bl'],
  'rounded-t': ['rounded-tl', 'rounded-tr'], 'rounded-r': ['rounded-tr', 'rounded-br'],
  'rounded-b': ['rounded-br', 'rounded-bl'], 'rounded-l': ['rounded-tl', 'rounded-bl'],
  'border-w': ['border-w-x', 'border-w-y', 'border-w-t', 'border-w-r', 'border-w-b', 'border-w-l'],
  'border-w-x': ['border-w-r', 'border-w-l'], 'border-w-y': ['border-w-t', 'border-w-b'],
  'border-color': ['border-color-x', 'border-color-y', 'border-color-t', 'border-color-r', 'border-color-b', 'border-color-l'],
  'border-color-x': ['border-color-r', 'border-color-l'],
  'border-color-y': ['border-color-t', 'border-color-b'],
  translate: ['translate-x', 'translate-y'],
  scale: ['scale-x', 'scale-y'],
  overflow: ['overflow-x', 'overflow-y'],
}

// Group of a bare (modifier-stripped, non-negative) class, or null when this
// table does not know it — unknown classes are never merged away, and the
// equivalence check fails the build if that silently differs from real
// tailwind-merge.
function groupOf(cls) {
  if (EXACT.has(cls)) return EXACT.get(cls)
  if (DISPLAY.has(cls)) return 'display'
  if (POSITION.has(cls)) return 'position'

  // Anything with an arbitrary property/selector segment ("[&_tr]:border-b" is
  // handled as a modifier; "[mask-type:luminance]" is a class) stays unique.
  if (cls.startsWith('[')) return null

  if (cls.startsWith('text-')) {
    const v = cls.slice(5)
    if (FONT_SIZES.has(v) || (v.startsWith('[') && !v.includes('#'))) return 'font-size'
    if (TEXT_ALIGN.has(v)) return 'text-align'
    return 'text-color'
  }
  if (cls.startsWith('font-')) {
    const v = cls.slice(5)
    if (FONT_WEIGHTS.has(v)) return 'font-weight'
    if (FONT_FAMILIES.has(v)) return 'font-family'
    return null
  }
  if (cls.startsWith('flex-')) {
    const v = cls.slice(5)
    if (FLEX_DIRECTION.has(v)) return 'flex-direction'
    if (FLEX_WRAP.has(v)) return 'flex-wrap'
    return 'flex'
  }
  if (cls.startsWith('overflow-')) {
    const rest = cls.slice(9)
    if (rest.startsWith('x-')) return 'overflow-x'
    if (rest.startsWith('y-')) return 'overflow-y'
    if (OVERFLOW_VALUES.has(rest)) return 'overflow'
    return null
  }
  if (cls.startsWith('whitespace-')) {
    return WHITESPACE.has(cls.slice(11)) ? 'whitespace' : null
  }
  if (cls.startsWith('break-')) {
    return WORD_BREAK.has(cls.slice(6)) ? 'word-break' : null
  }
  // border-*: width vs colour vs style, optionally per side.
  if (cls.startsWith('border-')) {
    let rest = cls.slice(7)
    let side = ''
    const m = /^(x|y|t|r|b|l)-(.*)$/.exec(rest)
    if (m) { side = '-' + m[1]; rest = m[2] }
    if (BORDER_STYLES.has(rest) && side === '') return 'border-style'
    if (isSizeValue(rest)) return 'border-w' + side
    return 'border-color' + side
  }
  // Families where, like border-*, the VALUE decides which CSS property is meant.
  if (cls.startsWith('ring-')) {
    const v = cls.slice(5)
    if (v === 'inset') return 'ring-inset'
    if (v.startsWith('offset-')) {
      return isSizeValue(v.slice(7)) ? 'ring-offset-w' : 'ring-offset-color'
    }
    return isSizeValue(v) ? 'ring-w' : 'ring-color'
  }
  if (cls.startsWith('outline-')) {
    const v = cls.slice(8)
    if (v.startsWith('offset-')) return 'outline-offset'
    if (BORDER_STYLES.has(v)) return 'outline-style'
    return isSizeValue(v) ? 'outline-w' : 'outline-color'
  }
  if (cls.startsWith('shadow-')) {
    const v = cls.slice(7)
    if (SHADOW_SIZES.has(v) || v.startsWith('[')) return 'shadow'
    return 'shadow-color'
  }
  if (cls.startsWith('stroke-')) {
    const v = cls.slice(7)
    return isSizeValue(v) ? 'stroke-w' : 'stroke-color'
  }
  if (cls.startsWith('divide-')) {
    let v = cls.slice(7)
    let axis = ''
    const m = /^(x|y)(?:-(.*))?$/.exec(v)
    if (m) { axis = '-' + m[1]; v = m[2] ?? '' }
    if (axis) return isSizeValue(v) ? 'divide-w' + axis : 'divide-color'
    if (v === 'reverse') return 'divide-reverse'
    if (BORDER_STYLES.has(v)) return 'divide-style'
    return 'divide-color'
  }
  if (cls.startsWith('translate-')) {
    const rest = cls.slice(10)
    if (rest.startsWith('x-')) return 'translate-x'
    if (rest.startsWith('y-')) return 'translate-y'
    return null
  }
  for (const [prefix, group] of SIMPLE_PREFIXES) {
    if (cls.startsWith(prefix)) return group
  }
  return null
}

/**
 * Merge a space-separated class string, dropping earlier classes that a later
 * one overrides. Same contract as tailwind-merge for the families in the table
 * above; unknown classes are always kept.
 * @param {string} input
 * @returns {string}
 */
export function twMerge(input) {
  const classes = String(input).split(/\s+/).filter(Boolean)
  const kept = []       // { cls, key } in source order
  const killed = new Set()  // indices into kept

  for (const cls of classes) {
    // Split modifiers (hover:, md:, dark:, data-[…]:, [&_tr]:) from the utility.
    // Only colons OUTSIDE square brackets separate modifiers.
    let depth = 0, lastColon = -1
    for (let i = 0; i < cls.length; i++) {
      const ch = cls[i]
      if (ch === '[') depth++
      else if (ch === ']') depth--
      else if (ch === ':' && depth === 0) lastColon = i
    }
    const mods = lastColon >= 0 ? cls.slice(0, lastColon + 1) : ''
    let base = lastColon >= 0 ? cls.slice(lastColon + 1) : cls
    // `!` important marker and a leading `-` (negative value) don't change the
    // group, and tailwind-merge treats `!p-2` and `p-2` as the same group.
    let bang = ''
    if (base.startsWith('!')) { bang = '!'; base = base.slice(1) }
    const negative = base.startsWith('-')
    if (negative) base = base.slice(1)

    const group = groupOf(base)
    if (group == null) { kept.push({ cls, key: null }); continue }

    // The modifier set is part of the identity: `hover:bg-x` never overrides a
    // plain `bg-y`. `!` likewise (tailwind-merge keys importance separately).
    const key = mods + bang + '|' + group
    const overrides = new Set([key])
    for (const g of ALSO_OVERRIDES[group] || []) overrides.add(mods + bang + '|' + g)

    for (let i = 0; i < kept.length; i++) {
      if (kept[i].key != null && overrides.has(kept[i].key)) killed.add(i)
    }
    kept.push({ cls, key })
  }

  return kept.filter((_, i) => !killed.has(i)).map((k) => k.cls).join(' ')
}
