import type { Build } from '@/lib/live'

/** Что можно предложить сделать с движком — в одном месте на весь интерфейс.
 *
 *  Место одно потому, что мест было два и они расходились. Левая колонка выбирала подпись
 *  по одному признаку («установлен ли движок вообще») и на свежей версии звала обновляться;
 *  карточка ниже ту же операцию называла «Переустановить». Человек читал первую подпись как
 *  состояние — «вышла новая версия», — шёл по ней и находил другое слово (I-038).
 *
 *  Сравнивать есть с чем: rpcd отдаёт установленную версию (engine) и релизы от новых к
 *  старым (steer_versions). Не хватало не данных, а того, чтобы кто-то их сопоставил. */

export interface Releases {
    /** Архитектура ПАКЕТОВ. Приходит и тогда, когда движка нет, — единственный ответ,
     *  который сообщает её в этом состоянии. */
    arch: string
    /** От новых к старым, уже отфильтрованные бэкендом до вида X.Y.Z. */
    versions: string[]
}

/** Сравнение версий по числам, а не по строкам: «0.9.10» строкой меньше «0.9.9».
 *  Возвращает <0, 0, >0 — как принято у компараторов. */
export function cmpVersion(a: string, b: string): number {
    const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
    const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d) return d
    }
    return 0
}

/** Что стоит и что можно поставить — про сам интерфейс.
 *
 *  Живёт здесь, рядом с версиями движка, а не в компоненте: lib не должен зависеть от
 *  components даже типом, иначе граница между слоями держится только на привычке. */
export interface SelfUpdateInfo {
    /** Что стоит сейчас. Пусто, если пакет поставлен руками мимо apk. */
    current: string
    /** Релизы от новых к старым, уже отобранные бэкендом до вида X.Y.Z. */
    versions: string[]
}

export interface EngineAction {
    /** Подпись кнопки. */
    label: string
    /** Самая свежая доступная версия — null, если список ещё не пришёл или пуст. */
    latest: string | null
    /** Установленное старее самого свежего. */
    outdated: boolean
}

export function engineAction(build: Build | null, releases: Releases | null): EngineAction {
    const latest = releases?.versions?.length ? releases.versions[0] : null

    if (!build?.present) return { label: 'Установить', latest, outdated: false }

    // Список ещё не пришёл (или интернета на роутере нет) — значит про «свежее» мы не знаем
    // ничего. Молчание здесь честнее догадки: обещать обновление, которого никто не
    // проверял, и есть та самая находка.
    if (!latest || !build.version) return { label: 'Переустановить', latest, outdated: false }

    const outdated = cmpVersion(build.version, latest) < 0
    return { label: outdated ? `Обновить до ${latest}` : 'Переустановить', latest, outdated }
}
