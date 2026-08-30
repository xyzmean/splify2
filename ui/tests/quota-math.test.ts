import { describe, expect, it } from 'vitest'
import { MIN_SPAN_MS, daysText, isStale, readQuota } from '@/lib/quota'
import type { SubQuota } from '@/lib/rpc'

// Andromeda 26.9 требует на обзоре четыре производные величины: остаток, до конца периода,
// средний расход в сутки и «хватит при таком темпе». Первые две выводятся из чисел панели
// прямо, а вот две последние — нет: начала периода панель не сообщает. Соблазн посчитать их
// из «обычно тридцать дней» здесь и проверяется как ошибка: на подписке на девяносто дней
// такой темп был бы завышен втрое, и обзор обещал бы, что трафик кончится, когда он не
// кончится.
//
// Поэтому темп МЕРЯЕТСЯ по двум наблюдениям (since/at от бэкенда), а пока измерять нечего —
// его нет вовсе. Отсутствие строки честнее числа, которое через час станет другим втрое.

const GB = 1024 ** 3
const HOUR = 3600

/** Панель со счётом: 200 ГБ на период, израсходовано 132, до сброса пятнадцать суток. */
function quota(p: Partial<SubQuota> = {}): SubQuota {
    return {
        up: String(2 * GB),
        down: String(130 * GB),
        total: String(200 * GB),
        expire: 0,
        at: 0,
        since: 0,
        since_used: '0',
        ...p,
    }
}

describe('остаток трафика: что считается прямо', () => {
    it('остаток — это объём минус израсходованное, обе половины расхода вместе', () => {
        const v = readQuota(quota())
        expect(v.used).toBe(132 * GB)
        expect(v.left).toBe(68 * GB)
        expect(v.part).toBeCloseTo(0.66, 2)
    })

    it('расход больше объёма — остаток нуль, а не долг', () => {
        const v = readQuota(quota({ up: '0', down: String(300 * GB) }))
        expect(v.left).toBe(0)
        expect(v.part).toBe(1)
    })

    it('объёма панель не назвала — остатка НЕТ, а не нуль', () => {
        // Подписка без ограничения по трафику: «осталось 0 из 0» было бы выдумкой
        // интерфейса, поэтому карточка в этой ветке показывает только срок.
        const v = readQuota(quota({ total: '' }))
        expect(v.total).toBeNull()
        expect(v.left).toBeNull()
        expect(v.part).toBeNull()
    })

    it('объём назван НУЛЁМ — это тоже «без ограничения», а не «ничего не осталось»', () => {
        // `total=0` — как панели (Marzban, Remnawave, 3x-ui) обозначают безлимитный тариф.
        // Прочитанный буквально, он давал остаток нуль при полной свободе.
        const v = readQuota(quota({ total: '0' }))
        expect(v.total).toBeNull()
        expect(v.left).toBeNull()
        expect(v.part).toBeNull()
        // Расход при этом считается: он есть и без ограничения.
        expect(v.used).toBe(132 * GB)
    })

    it('до конца периода округляется ВНИЗ', () => {
        // Двадцать пять часов — это «остался день», а не «два»: округление вверх обещало бы
        // сутки, которых нет.
        const now = 1_800_000_000_000
        const v = readQuota(quota({ expire: now / 1000 + 25 * HOUR }), now)
        expect(v.daysLeft).toBe(1)
    })

    it('срок прошёл — не отрицательное число суток', () => {
        const now = 1_800_000_000_000
        const v = readQuota(quota({ expire: now / 1000 - 10 * HOUR }), now)
        expect(v.daysLeft).toBe(0)
    })
})

describe('темп расхода: только измеренный', () => {
    const now = 1_800_000_000_000

    it('наблюдения ближе шести часов — темпа нет вовсе', () => {
        const v = readQuota(
            quota({
                at: now / 1000,
                since: (now - (MIN_SPAN_MS - 1000)) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(v.perDay).toBeNull()
        expect(v.forecastDays).toBeNull()
        expect(v.tight).toBe(false)
    })

    it('наблюдения разнесены — темп считается по разнице, а не по длине периода', () => {
        // За двое суток израсходовано 32 ГБ, значит 16 ГБ в сутки. Никакой «месячной» длины
        // периода в этом числе нет.
        const v = readQuota(
            quota({
                at: now / 1000,
                since: (now - 2 * 86400 * 1000) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(v.perDay).toBeCloseTo(16 * GB, -6)
        // Остаток 68 ГБ при 16 ГБ в сутки — на четыре полных суток.
        expect(v.forecastDays).toBe(4)
    })

    it('кончится раньше сброса — сказано отдельным признаком', () => {
        const v = readQuota(
            quota({
                expire: now / 1000 + 15 * 86400,
                at: now / 1000,
                since: (now - 2 * 86400 * 1000) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(v.tight).toBe(true)
    })

    it('хватит дольше, чем до сброса — признака нет', () => {
        const v = readQuota(
            quota({
                expire: now / 1000 + 2 * 86400,
                at: now / 1000,
                since: (now - 10 * 86400 * 1000) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(v.tight).toBe(false)
    })

    it('запаса больше, чем длится период — сказано отдельным признаком', () => {
        // Расход 3,2 ГБ в сутки, остаток 68 ГБ — двадцать один день, а до сброса два.
        // Число суток в этом месте перестаёт быть сроком, и карточка ставит вместо него ∞.
        const v = readQuota(
            quota({
                expire: now / 1000 + 2 * 86400,
                at: now / 1000,
                since: (now - 10 * 86400 * 1000) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(v.outlasts).toBe(true)
        expect(v.tight).toBe(false)
    })

    it('срока панель не назвала — ∞ только при запасе больше года', () => {
        // Сравнивать не с чем, поэтому порог не «до сброса», а «дольше, чем живёт подписка».
        const slow = readQuota(
            quota({
                expire: 0,
                up: '0',
                down: String(132 * GB),
                at: now / 1000,
                since: (now - 2 * 86400 * 1000) / 1000,
                since_used: String(132 * GB - 10 * 1024 ** 2),
            }),
            now,
        )
        expect(slow.outlasts).toBe(true)
        const fast = readQuota(
            quota({
                expire: 0,
                at: now / 1000,
                since: (now - 2 * 86400 * 1000) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(fast.outlasts).toBe(false)
    })

    it('панель обнулила счётчик между наблюдениями — темпа нет, а не «минус в сутки»', () => {
        const v = readQuota(
            quota({
                up: '0',
                down: String(GB),
                at: now / 1000,
                since: (now - 5 * 86400 * 1000) / 1000,
                since_used: String(100 * GB),
            }),
            now,
        )
        expect(v.perDay).toBeNull()
    })
})

describe('когда пора спрашивать панель заново', () => {
    const now = 1_800_000_000_000
    it('числа свежие — не ходим наружу', () => {
        expect(isStale(quota({ at: (now - 60_000) / 1000 }), now)).toBe(false)
    })
    it('числам больше четверти часа — пора', () => {
        expect(isStale(quota({ at: (now - 16 * 60_000) / 1000 }), now)).toBe(true)
    })
    it('чисел нет вовсе — тоже пора', () => {
        expect(isStale(undefined, now)).toBe(true)
    })
})

describe('сутки словами', () => {
    it('склоняет числительное', () => {
        expect(daysText(1)).toBe('1 день')
        expect(daysText(2)).toBe('2 дня')
        expect(daysText(5)).toBe('5 дней')
        expect(daysText(11)).toBe('11 дней')
        expect(daysText(21)).toBe('21 день')
        expect(daysText(0)).toBe('0 дней')
    })
})
