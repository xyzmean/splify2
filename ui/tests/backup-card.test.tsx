import { fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BackupCard, { BACKUP_CHUNK, cutChunks, readBackup } from '@/components/BackupCard'
import { rpc } from '@/lib/rpc'
import { pending } from '@/lib/pending'

// R-005: бекапа и переноса настроек не было вовсе, а штатный архив системы настройки
// splify2 не содержит (I-037). Здесь проверяется клиентская половина: сборка архива из
// кусков, нарезка на куски при отправке, и — главное — что восстановление НЕ применяется
// само и не даёт прежней спеке уехать поверх восстановленной.

/** Выбрать файл — двумя обходами, и оба не косметические.
 *
 *  Первый: `files` у input только для чтения, присвоить его событием нельзя, поэтому
 *  свойство подменяется на самом элементе.
 *
 *  Второй: событие отправляется НАПРЯМУЮ, а не через fireEvent.change. Обёртка
 *  @testing-library/preact переименовывает change в input (fire-event.js: `key === 'change'
 *  ? 'input'`) — это верно для текстовых полей, где preact/compat действительно слушает
 *  input, но НЕ для type="file": для file, checkbox и radio compat оставляет onchange как
 *  есть (render.js, onChangeInputType). То есть fireEvent.change по файловому полю не
 *  доходит до обработчика вовсе и проверка молча проверяла бы ничего. */
function pickFile(input: HTMLElement, text: string) {
    Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File([text], 'b.txt', { type: 'text/plain' })],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** URL.createObjectURL в jsdom нет вовсе, а без него не проверить, ЧТО скачивается. */
function stubDownload() {
    const saved: { name: string; blob: Blob }[] = []
    const url = 'blob:test'
    // @ts-expect-error jsdom не реализует ни того, ни другого
    URL.createObjectURL = (b: Blob) => { saved.push({ name: '', blob: b }); return url }
    // @ts-expect-error там же
    URL.revokeObjectURL = () => {}
    const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(function (this: HTMLAnchorElement) {
            if (saved.length) saved[saved.length - 1].name = this.download
        })
    return { saved, click }
}

describe('нарезка архива на куски', () => {
    it('куски не длиннее предела и склеиваются обратно в исходный текст (R-005)', () => {
        const text = 'a'.repeat(BACKUP_CHUNK * 2 + 17)
        const parts = cutChunks(text)
        expect(parts.length).toBe(3)
        expect(parts.every((p) => p.length <= BACKUP_CHUNK)).toBe(true)
        expect(parts.join('')).toBe(text)
    })

    it('суррогатная пара не разрезается пополам (R-005)', () => {
        // Имя узла в ссылке vless:// бывает с эмодзи, а половина пары — не символ:
        // JSON.stringify поставил бы на её месте замену, и файл приехал бы искажённым.
        const parts = cutChunks('ab😀cd', 3)
        expect(parts[0]).toBe('ab')
        expect(parts.join('')).toBe('ab😀cd')
        for (const p of parts) expect(p).toBe(JSON.parse(JSON.stringify(p)))
    })
})

describe('чтение архива по кускам', () => {
    it('склеивает куски и идёт по смещению, которое прислал роутер (R-005)', async () => {
        const get = vi.spyOn(rpc, 'backupGet').mockImplementation(async (offset: number) =>
            offset === 0
                ? { ok: true, text: 'splify2-backup 1\n', total: 30, next: 17, eof: false }
                : { ok: true, text: '[spec]\n{"schema":1}\n', total: 30, next: 30, eof: true },
        )
        await expect(readBackup()).resolves.toBe('splify2-backup 1\n[spec]\n{"schema":1}\n')
        // Смещение НЕ считается на этой стороне: роутер считает байты, строка в браузере —
        // символы, и своя арифметика разъехалась бы на первой русской букве.
        expect(get.mock.calls.map((c) => c[0])).toEqual([0, 17])
        get.mockRestore()
    })

    it('не крутится вечно, если роутер не двигает смещение (R-005)', async () => {
        const get = vi
            .spyOn(rpc, 'backupGet')
            .mockResolvedValue({ ok: true, text: 'x', total: 99, next: 0, eof: false })
        await expect(readBackup()).rejects.toThrow(/не полностью/)
        expect(get).toHaveBeenCalledTimes(1)
        get.mockRestore()
    })
})

describe('карточка бекапа', () => {
    beforeEach(() => { vi.restoreAllMocks() })

    it('говорит, что категорий издателя в архиве нет (R-005)', () => {
        render(<BackupCard />)
        expect(screen.getByText(/284 КБ/)).toBeInTheDocument()
    })

    it('предупреждает про ключи в файле до нажатия (R-005)', () => {
        render(<BackupCard />)
        expect(screen.getByText(/Храните его как пароль/)).toBeInTheDocument()
    })

    it('скачивает собранный архив файлом с датой в имени (R-005)', async () => {
        const { saved } = stubDownload()
        vi.spyOn(rpc, 'backupGet').mockResolvedValue({
            ok: true, text: 'splify2-backup 1\n[options]\n', total: 27, next: 27, eof: true,
        })
        render(<BackupCard />)
        fireEvent.click(screen.getByRole('button', { name: /Скачать архив/ }))
        await waitFor(() => expect(saved.length).toBe(1))
        expect(await saved[0].blob.text()).toBe('splify2-backup 1\n[options]\n')
        expect(saved[0].name).toMatch(/^splify2-backup-\d{4}-\d{2}-\d{2}\.txt$/)
    })

    it('восстановление спрашивает подтверждение и без него ничего не шлёт (R-005)', async () => {
        const put = vi.spyOn(rpc, 'backupPut')
        render(<BackupCard />)
        pickFile(screen.getByLabelText('Файл с настройками'), 'splify2-backup 1\n')
        await screen.findByText(/Восстановить настройки из файла/)
        fireEvent.click(screen.getByRole('button', { name: /Cancel|Отмена/ }))
        await waitFor(() => expect(put).not.toHaveBeenCalled())
    })

    it('шлёт куски с верными признаками append и final (R-005)', async () => {
        // Булевы, а не 1/0: политика ubus для этих полей BOOL, и число до скрипта не
        // доходит вовсе — тогда каждый кусок замещал бы предыдущий, а разбор не начался бы.
        const put = vi.spyOn(rpc, 'backupPut').mockResolvedValue({ ok: true, spec: true })
        const flush = vi.spyOn(pending, 'flush').mockResolvedValue(undefined)
        const onRestored = vi.fn()
        const text = 'splify2-backup 1\n' + 'x'.repeat(BACKUP_CHUNK)
        render(<BackupCard onRestored={onRestored} />)
        pickFile(screen.getByLabelText('Файл с настройками'), text)
        fireEvent.click(await screen.findByRole('button', { name: /Восстановить/ }))
        await waitFor(() => expect(onRestored).toHaveBeenCalled())
        expect(put.mock.calls.map(([p]) => [p.append, p.final])).toEqual([
            [false, false],
            [true, true],
        ])
        expect(put.mock.calls.map(([p]) => p.text).join('')).toBe(text)
        // Несохранённая правка дописывается ДО восстановления: иначе страховка на уход со
        // страницы допишет её ПОСЛЕ и прежняя спека ляжет поверх восстановленной.
        expect(flush).toHaveBeenCalled()
        expect(flush.mock.invocationCallOrder[0]).toBeLessThan(put.mock.invocationCallOrder[0])
    })

    it('отказ бэкенда не выдаётся за восстановление (R-005)', async () => {
        const put = vi
            .spyOn(rpc, 'backupPut')
            .mockResolvedValue({ ok: false, error: 'это не файл настроек splify2' })
        vi.spyOn(pending, 'flush').mockResolvedValue(undefined)
        const onRestored = vi.fn()
        render(<BackupCard onRestored={onRestored} />)
        pickFile(screen.getByLabelText('Файл с настройками'), 'мусор\n')
        fireEvent.click(await screen.findByRole('button', { name: /Восстановить/ }))
        await waitFor(() => expect(put).toHaveBeenCalled())
        expect(onRestored).not.toHaveBeenCalled()
    })
})

// Где живёт карточка. Раньше — под пультом, на всю ширину и на КАЖДОМ экране: довод был
// «архив не про маршрутизацию, а про весь экран целиком». Довод верный, вывод из него
// неверный — карточка занимала место постоянно ради действия, которое делают раз в жизни.
// Теперь она в разделе «Система», рядом с остальным, что не про маршрутизацию (движок и
// самообновление). Прежний довод при этом выполняется: раздел доступен всегда, в том числе
// когда настройка ещё не работает и переносить её надо на новый роутер.
//
// До Andromeda 26.9 разделом была вкладка «Логи steer»: в неё въехало всё, что не влезло в
// остальные три, — диагностика, счётчики, движок, самообновление и архив. Новое меню это
// разделение закрепляет: архив лежит в «Настройках», в подпункте «Дополнительно».
describe('где живёт карточка архива', () => {
    it('в «Настройках», в подпункте «Дополнительно»', async () => {
        const { default: Settings } = await import('@/components/sections/Settings')
        const { live } = await import('./fixtures')
        const { rpc } = await import('@/lib/rpc')
        vi.spyOn(rpc, 'localLists').mockResolvedValue({ files: {} })
        render(<Settings live={live()} onUseInRule={() => {}} />)
        screen.getByRole('button', { name: /Дополнительно/ }).click()
        expect(await screen.findByText('Бекап настроек')).toBeInTheDocument()
    })

    it('не под пультом: на главной её нет', async () => {
        const { default: App } = await import('@/App')
        render(<App />)
        expect(screen.queryByText('Бекап настроек')).toBeNull()
    })
})
