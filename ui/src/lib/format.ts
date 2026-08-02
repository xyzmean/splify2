// Presentation helpers shared across the dashboard (ported from the 2.0
// dashboard.js so the React UI reads identically).

export function fmtAge(s: number | null | undefined): string {
  if (s == null || s < 0 || s >= 999999) return '—'
  if (s < 120) return s + ' с'
  if (s < 7200) return Math.round(s / 60) + ' мин'
  return Math.round(s / 3600) + ' ч'
}

export function fmtRate(bps: number): string {
  if (bps == null || !isFinite(bps) || bps < 1) return '0'
  const u = ['Б/с', 'КБ/с', 'МБ/с', 'ГБ/с']
  let i = 0
  while (bps >= 1000 && i < u.length - 1) { bps /= 1000; i++ }
  return (bps < 10 && i > 0 ? bps.toFixed(1) : Math.round(bps).toString()) + ' ' + u[i]
}

export function fmtBytes(b: number): string {
  if (!b) return '0'
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let i = 0
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
  return (b < 10 && i > 0 ? b.toFixed(1) : Math.round(b).toString()) + ' ' + u[i]
}

export function fmtWhen(ts: number): string {
  const d = Date.now() / 1000 - ts
  if (d < 0) return 'только что'
  if (d < 60) return Math.round(d) + ' с назад'
  if (d < 3600) return Math.round(d / 60) + ' мин назад'
  if (d < 86400) return Math.round(d / 3600) + ' ч назад'
  return new Date(ts * 1000).toLocaleString()
}

export function fmtUnix(s: string): string {
  const n = Number(s)
  if (!n) return 'никогда'
  return fmtWhen(n)
}
