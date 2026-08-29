import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'
import EngineCard from '@/components/EngineCard'
import SelfUpdateCard from '@/components/SelfUpdateCard'

// splify2#15: перечень версий спрашивался у одного хоста — api.github.com.
//
// Пакеты и списки обход блокировки получили ещё в запуске 59, а список версий нет: там,
// где хост закрыт или где за CGNAT выбран его лимит, обе карточки оставались с пустым
// выпадающим списком. Бэкенд теперь откатывается на VERSION в главной ветке (её берёт та
// же download() с зеркалом), и обязан сказать об этом словами — иначе одна версия в списке
// читается как «релиз всего один».
//
// Вторая половина — куда посылать человека, когда не приехало ничего. Ссылка на
// github.com в этом состоянии бесполезна ровно тем, кому она адресована: у них закрыт
// именно GitHub. Зеркало работает в обоих случаях, и README давно называет его первым.

const noop = () => {}
const ENGINE = { present: true, vless: true, version: '1.2.4' }

describe('перечень версий не приехал (splify2#15)', () => {
    it('карточка движка ведёт на зеркало, а не только на github', () => {
        render(<EngineCard engine={ENGINE} releases={{ arch: 'mipsel_24kc', versions: [] }} onInstalled={noop} />)
        const links = screen.getAllByRole('link')
        expect(links.some((a) => a.getAttribute('href')?.includes('gitlab.com'))).toBe(true)
    })

    it('карточка интерфейса тоже объясняет пустой список, а не молчит', () => {
        render(<SelfUpdateCard info={{ current: '1.2.4', versions: [] }} onInstalled={noop} />)
        expect(screen.getByText(/Список версий не пришёл/)).toBeInTheDocument()
        const links = screen.getAllByRole('link')
        expect(links.some((a) => a.getAttribute('href')?.includes('gitlab.com'))).toBe(true)
    })
})

describe('перечень приехал запасным путём (splify2#15)', () => {
    const note = 'список релизов не отдали — версия взята из VERSION в main'

    it('движок печатает примечание бэкенда дословно', () => {
        render(
            <EngineCard
                engine={ENGINE}
                releases={{ arch: 'mipsel_24kc', versions: ['1.2.5'], note }}
                onInstalled={noop}
            />,
        )
        expect(screen.getByText(new RegExp('VERSION в main'))).toBeInTheDocument()
    })

    it('интерфейс печатает его же', () => {
        render(<SelfUpdateCard info={{ current: '1.2.4', versions: ['1.2.5'], note }} onInstalled={noop} />)
        expect(screen.getByText(new RegExp('VERSION в main'))).toBeInTheDocument()
    })

    it('на здоровом пути примечания нет — и на экране его тоже нет', () => {
        render(
            <EngineCard
                engine={ENGINE}
                releases={{ arch: 'mipsel_24kc', versions: ['1.2.5', '1.2.4'] }}
                onInstalled={noop}
            />,
        )
        expect(screen.queryByText(/VERSION/)).toBeNull()
    })
})
