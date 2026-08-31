import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CustomLists from '@/components/CustomLists'
import { customServices } from '@/lib/model'
import { selectedIds } from '@/components/tabs/RuleEditor'
import { rpc } from '@/lib/rpc'

// R-037: свой список нельзя было ни добавить, ни выбрать в правиле.
//
// Движок сопоставляет только по файлам, а каталог рисуется из манифеста издателя,
// поэтому свой .lst в /etc/steer/lists был виден local_lists — и не предлагался ни
// одному правилу. Редактор выбирает из ServiceEntry[], и собственного файла среди них
// не было.

const LOCAL = {
    'news.lst': { count: 5444, mtime: 1 },
    'domains/news.lst': { count: 250, mtime: 1 },
    'custom/mine.lst': { count: 3, mtime: 1 },
    'custom/domains/mine.lst': { count: 7, mtime: 1 },
}

describe('свои списки как записи каталога', () => {
    it('берутся только из custom/, чужие не трогаются (R-037)', () => {
        expect(customServices(LOCAL).map((s) => s.name)).toEqual(['mine', 'mine'])
    })

    it('вид читается из пути, а не из имени файла (R-037)', () => {
        const [a, b] = customServices(LOCAL)
        // Одно имя, два разных списка — ровно та коллизия, на которой проект уже
        // обжигался (I-011). Схлопнуть их нельзя: они уходят в РАЗНЫЕ поля правила.
        expect(a.id).not.toBe(b.id)
        expect([a.prefixes.length + b.prefixes.length, a.domains.length + b.domains.length]).toEqual([1, 1])
    })

    it('правило, указывающее на свой файл, видит его выбранным (R-037)', () => {
        const svc = customServices(LOCAL)
        const ch = {
            name: 'c1',
            match: { domains_files: ['/etc/steer/lists/custom/domains/mine.lst'] },
            output: 'direct',
        }
        // Тот же selectedIds, которым пользуется редактор: если он своего файла не
        // узнаёт, список выглядит невыбранным и человеку предлагают включить включённое.
        expect(selectedIds(ch as never, svc)).toContain('custom:domains:mine')
    })

    it('свой список не выдаёт себя за категорию издателя с тем же именем (R-037)', () => {
        const svc = customServices({ 'custom/domains/news.lst': { count: 1, mtime: 1 } })
        expect(svc[0].id).toBe('custom:domains:news')
        expect(svc[0].id).not.toBe('news')
    })
})

describe('форма своих списков', () => {
    it('показывает уже добавленные с их видом и числом записей (R-037)', () => {
        render(<CustomLists local={LOCAL} onChanged={() => {}} />)
        expect(screen.getByText(/домены · записей 7/)).toBeInTheDocument()
        expect(screen.getByText(/подсети · записей 3/)).toBeInTheDocument()
    })

    it('предлагает все три способа ввода (R-037)', () => {
        render(<CustomLists local={{}} onChanged={() => {}} />)
        expect(screen.getByLabelText('Записи списка')).toBeInTheDocument()
        expect(screen.getByLabelText('Файл со списком')).toBeInTheDocument()
        expect(screen.getByLabelText('Ссылка на список')).toBeInTheDocument()
    })

    it('говорит, что расписания у своего списка нет (R-037)', () => {
        render(<CustomLists local={{}} onChanged={() => {}} />)
        expect(screen.getByText(/расписание есть только у списков издателя/i)).toBeInTheDocument()
    })

    it('негодное имя названо до отправки, и отправить нечем (R-037)', () => {
        const put = vi.spyOn(rpc, 'listPut')
        render(<CustomLists local={{}} onChanged={() => {}} />)
        fireEvent.input(screen.getByLabelText('Имя списка'), { target: { value: '../etc/passwd' } })
        expect(screen.getByText(/только латиница, цифры, дефис и подчёркивание/)).toBeInTheDocument()
        expect(put).not.toHaveBeenCalled()
        put.mockRestore()
    })
})

// ---- ПРАВКА уже заведённого списка ------------------------------------------------------
//
// Изменить свой список было нечем: рядом с ним стояла одна кнопка — удалить. «Поправить одну
// строку» означало завести заново, а у списка из файла на двадцать тысяч строк — ещё и найти
// тот файл.
//
// Правится список по тому же разделению, каким его завели, и это не оформление: у файла
// меняют ФАЙЛ, у ссылки — ССЫЛКУ, у набранного руками — сами ЗАПИСИ. Ошибка здесь молчаливая
// по построению — запись списка ЗАМЕЩАЕТ его целиком, поэтому редактор записей, показавший
// пустое поле, стоит человеку всего набранного при первом же «Сохранить».

const ONE = { 'custom/mine.lst': { count: 3, mtime: 1 } }

function meta(over: Partial<{
    source: string; url: string; filename: string; bytes: number
}> = {}) {
    return vi.spyOn(rpc, 'listCustom').mockResolvedValue({
        lists: [{
            name: 'mine', kind: 'prefixes', path: '/etc/steer/lists/custom/mine.lst',
            count: 3, bytes: 30, source: 'text', url: '', filename: '', at: 100, ...over,
        }],
    } as never)
}

describe('правка своего списка', () => {
    beforeEach(() => { vi.restoreAllMocks() })

    it('показывает, чем список завели', async () => {
        meta({ source: 'file', filename: 'blocked.txt' })
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        await waitFor(() => expect(screen.getByText(/файл blocked\.txt/)).toBeInTheDocument())
    })

    it('у списка из файла предлагает ДРУГОЙ ФАЙЛ, а не текстовое поле', async () => {
        meta({ source: 'file', filename: 'blocked.txt' })
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        expect(await screen.findByLabelText('Другой файл для списка mine')).toBeInTheDocument()
        // Ни поля записей, ни ссылки: предложить их значило бы предложить заменить файл на
        // двадцать тысяч строк тем, что человек наберёт руками.
        expect(screen.queryByLabelText('Записи списка mine')).not.toBeInTheDocument()
        expect(screen.queryByLabelText('Ссылка списка mine')).not.toBeInTheDocument()
    })

    it('у списка по ссылке предлагает ССЫЛКУ, и она уже подставлена', async () => {
        meta({ source: 'url', url: 'https://example.org/a.lst' })
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        const field = await screen.findByLabelText('Ссылка списка mine')
        expect((field as HTMLInputElement).value).toBe('https://example.org/a.lst')
        expect(screen.queryByLabelText('Записи списка mine')).not.toBeInTheDocument()
    })

    it('у набранного руками показывает ЗАПИСИ С РОУТЕРА, а не пустое поле', async () => {
        // Запись списка замещает его целиком. Пустое поле здесь — это не «начни заново», а
        // предложение незаметно потерять всё набранное: человек допишет строку, нажмёт
        // «Сохранить», и остальные исчезнут.
        meta({ source: 'text', bytes: 30 })
        vi.spyOn(rpc, 'listGet').mockResolvedValue({
            ok: true, total: 30, offset: 0, eof: true, text: '10.0.0.0/8\n192.0.2.0/24\n',
        } as never)
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        const area = await screen.findByLabelText('Записи списка mine')
        expect((area as HTMLTextAreaElement).value).toBe('10.0.0.0/8\n192.0.2.0/24\n')
    })

    it('порции склеиваются байт в байт', async () => {
        // Границы кусков не по строкам: потерянный на границе перевод строки склеивает две
        // записи в одну («10.0.0.0/810.1.0.0/8»), и обе исчезают из канала молча.
        meta({ source: 'text', bytes: 22 })
        vi.spyOn(rpc, 'listGet').mockImplementation(((_n: string, _k: string, off: number) =>
            Promise.resolve(off === 0
                ? { ok: true, total: 22, offset: 0, next: 11, eof: false, text: '10.0.0.0/8\n' }
                : { ok: true, total: 22, offset: 11, eof: true, text: '10.1.0.0/8\n' })) as never)
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        const area = await screen.findByLabelText('Записи списка mine')
        expect((area as HTMLTextAreaElement).value).toBe('10.0.0.0/8\n10.1.0.0/8\n')
    })

    it('записи не прочитались — поля нет вовсе, и сказано почему', async () => {
        meta({ source: 'text', bytes: 30 })
        vi.spyOn(rpc, 'listGet').mockResolvedValue({ ok: false, error: 'своего списка нет' } as never)
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        await waitFor(() => expect(screen.getByText(/Записи не прочитались/)).toBeInTheDocument())
        expect(screen.queryByLabelText('Записи списка mine')).not.toBeInTheDocument()
    })

    it('слишком большой список текстом не правится, и причина названа', async () => {
        meta({ source: 'text', bytes: 300000 })
        const get = vi.spyOn(rpc, 'listGet')
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        await waitFor(() => expect(screen.getByText(/слишком велик/)).toBeInTheDocument())
        // И записи не качаются: мегабайт ради поля, которого не будет.
        expect(get).not.toHaveBeenCalled()
    })

    it('происхождение неизвестно — предлагаются все три способа', async () => {
        // Так выглядят списки от прежней версии, положенные в каталог руками и вернувшиеся из
        // архива настроек. Угадать способ нельзя, и признать незнание честнее, чем предложить
        // один неверный.
        meta({ source: '', bytes: 30 })
        vi.spyOn(rpc, 'listGet').mockResolvedValue({ ok: true, total: 30, eof: true, text: 'a\n' } as never)
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        expect(await screen.findByLabelText('Другой файл для списка mine')).toBeInTheDocument()
        expect(await screen.findByLabelText('Ссылка списка mine')).toBeInTheDocument()
        expect(await screen.findByLabelText('Записи списка mine')).toBeInTheDocument()
    })

    it('сохранение записей замещает список и называет происхождение', async () => {
        meta({ source: 'text', bytes: 30 })
        vi.spyOn(rpc, 'listGet').mockResolvedValue({ ok: true, total: 30, eof: true, text: 'a.org\n' } as never)
        const put = vi.spyOn(rpc, 'listPut').mockResolvedValue({ ok: true, count: 2, dropped: 0 } as never)
        render(<CustomLists local={ONE} onChanged={() => {}} />)
        fireEvent.click(await screen.findByLabelText('Изменить список mine'))
        const area = await screen.findByLabelText('Записи списка mine')
        fireEvent.input(area, { target: { value: 'a.org\nb.org\n' } })
        fireEvent.click(screen.getByText('Сохранить записи'))
        // Без append: правка — это перезапись целиком, а не дописывание к прежнему.
        await waitFor(() => expect(put).toHaveBeenCalledWith({
            name: 'mine', kind: 'prefixes', text: 'a.org\nb.org\n', source: 'text',
        }))
    })

    it('нельзя править список, которого нет: правки предлагаются только своим', async () => {
        // Список издателя приезжает по расписанию, и всякая правка была бы стёрта следующим
        // обновлением молча. Кнопки правки у него нет вовсе — их рисует только этот блок, а он
        // перечисляет ровно custom/.
        meta()
        render(<CustomLists local={{ 'news.lst': { count: 5444, mtime: 1 } }} onChanged={() => {}} />)
        await waitFor(() => expect(screen.queryByLabelText(/Изменить список/)).not.toBeInTheDocument())
    })
})
