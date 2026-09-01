import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as stub from './stub/lucide-react'

// Заглушка иконок обязана знать каждую иконку, которую импортирует интерфейс: отсутствующий
// именованный экспорт в ESM — это undefined, и preact рисует на месте компонента текст
// «[object Object]». Так стенд Zapret молча проверял кнопку с мусором внутри и не находил её
// по имени. Здесь список заглушки сверяется с исходниками — новая иконка ломает стенд громко.

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : []
    })
}

describe('заглушка lucide-react', () => {
    it('экспортирует каждую иконку, которую импортирует интерфейс', () => {
        const used = new Set<string>()
        for (const f of walk(join(__dirname, '..', 'src'))) {
            const s = readFileSync(f, 'utf8')
            for (const m of s.matchAll(/import \{([^}]*)\} from 'lucide-react'/g))
                for (const part of m[1].split(','))
                    if (part.trim()) used.add(part.trim().split(/\s+as\s+/)[0])
        }
        const missing = [...used].filter((n) => typeof (stub as Record<string, unknown>)[n] !== 'function')
        expect(missing).toEqual([])
    })
})
