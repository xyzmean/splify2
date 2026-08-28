import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import Rail from '@/components/Rail'
import EngineCard from '@/components/EngineCard'
import { live } from './fixtures'

// I-038: подпись «Обновить» выбиралась по одному признаку — установлен ли движок вообще, —
// и с доступными версиями не сверялась нигде. На роутере с самой свежей версией кнопка
// звала обновляться, а дойдя до неё, человек читал уже другое слово: та же операция в
// карточке названа «Переустановить».
//
// Замерено на стенде: engine.version = 0.9.5 и steer_versions.versions[0] = 0.9.5.
//
// Проверки нарочно смотрят на ОБА места сразу: расхождение двух подписей об одной операции
// и есть находка, поэтому один компонент её не покажет.

const RELEASES = { arch: 'aarch64_cortex-a53', versions: ['0.9.6', '0.9.5', '0.9.4'] }
const noop = () => {}

/** Подвал рельса — то место, где подпись действия над движком видна с любого раздела.
 *  Прежде она стояла в закреплённой колонке состояния (StatusRail), которой больше нет. */
const rail = (l: Parameters<typeof Rail>[0]['live']) => (
    <Rail live={l} section="overview" onSection={noop} counts={{}} />
)

describe('подпись действия над движком', () => {
    it('на свежей версии не зовёт обновляться (I-038)', () => {
        render(rail(live({
            build: { present: true, vless: true, version: '0.9.6', arch: 'aarch64_cortex-a53' },
            releases: RELEASES,
        })))
        expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull()
        expect(screen.getByRole('button', { name: 'Переустановить' })).toBeInTheDocument()
    })

    it('на устаревшей называет версию, до которой обновит (I-038)', () => {
        render(rail(live({
            build: { present: true, vless: true, version: '0.9.4', arch: 'aarch64_cortex-a53' },
            releases: RELEASES,
        })))
        expect(screen.getByRole('button', { name: 'Обновить до 0.9.6' })).toBeInTheDocument()
    })

    it('пока список версий не пришёл, не утверждает ничего (I-038)', () => {
        render(rail(live({ build: { present: true, vless: true, version: '0.9.4' }, releases: null })))
        expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull()
    })

    it('без движка зовёт установить', () => {
        render(rail(live({ build: { present: false, vless: false }, releases: RELEASES })))
        expect(screen.getByRole('button', { name: 'Установить' })).toBeInTheDocument()
    })

    it('рельс и карточка говорят об одной операции одно и то же (I-038)', () => {
        const build = { present: true, vless: true, version: '0.9.4', arch: 'aarch64_cortex-a53' }
        const shown = render(rail(live({ build, releases: RELEASES })))
        const railLabel = shown.getByRole('button', { name: /Обновить|Переустановить|Установить/ }).textContent
        shown.unmount()

        render(<EngineCard engine={build} releases={RELEASES} onInstalled={noop} />)
        const cardLabel = screen.getByRole('button', { name: /Обновить|Переустановить|Установить/ }).textContent

        expect(cardLabel).toBe(railLabel)
    })
})

// I-051: пока движок не установлен, архитектуру не показывает никто — хотя steer_versions
// присылает её именно в этом состоянии (у метода engine в нём ранний выход без поля arch).
// А зависит от неё то, скачается ли пакет вообще: релиз собран под шесть целей.
describe('архитектура', () => {
    it('показана, когда движка ещё нет (I-051)', () => {
        render(<EngineCard engine={{ present: false, vless: false }} releases={RELEASES} onInstalled={noop} />)
        expect(screen.getByText(/aarch64_cortex-a53/)).toBeInTheDocument()
    })
})
