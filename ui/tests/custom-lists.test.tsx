import { fireEvent, render, screen } from '@testing-library/preact'
import { describe, expect, it, vi } from 'vitest'
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
