/** Заглушка иконок для стенда.
 *
 *  Зачем она есть. lucide-react — единственная зависимость интерфейса, которая сама
 *  импортирует react, и единственная, до которой не доходит alias react → preact/compat:
 *  vitest отдаёт пакеты из node_modules напрямую node, минуя трансформацию. В итоге её
 *  forwardRef возвращал НАСТОЯЩИЙ React-объект, preact видел объект на месте имени тега и
 *  падал с «[object Object] did not match the QName production».
 *
 *  Ни server.deps.inline, ни прединлайн через esbuild этого не меняют — проверено. Выбор
 *  был между «проверять интерфейс на react вместо preact» и «подменить иконки»: первое
 *  меняет рантайм под всем стендом ради одной библиотеки, второе — убирает из проверки то,
 *  что в ней и не участвует. Ни одна проверка на иконки не смотрит: они декоративные и
 *  помечены aria-hidden.
 *
 *  Список ниже — ВСЕ иконки, которые интерфейс импортирует (собран по `import … from
 *  'lucide-react'` в src). Прежний список был короче, и стенд НЕ падал: отсутствующий экспорт
 *  в ESM — это undefined, preact рисовал на его месте текст «[object Object]», и стенд молча
 *  проверял разметку с мусором. Появится новая иконка — добавьте её сюда; проверка ниже в
 *  tests/icons-stub.test.ts сверяет список с исходниками и падает громко.
 */
type Props = Record<string, unknown>

const icon = (name: string) =>
    function Icon(props: Props) {
        return <svg data-icon={name} {...props} />
    }

export const AlertTriangle = icon('AlertTriangle')
export const ArrowDown = icon('ArrowDown')
export const ArrowLeft = icon('ArrowLeft')
export const ArrowRight = icon('ArrowRight')
export const ArrowUp = icon('ArrowUp')
export const Check = icon('Check')
export const ChevronDown = icon('ChevronDown')
export const ChevronLeft = icon('ChevronLeft')
export const ChevronRight = icon('ChevronRight')
export const Copy = icon('Copy')
export const Download = icon('Download')
export const ExternalLink = icon('ExternalLink')
export const Eye = icon('Eye')
export const EyeOff = icon('EyeOff')
export const Gauge = icon('Gauge')
export const Globe = icon('Globe')
export const GripVertical = icon('GripVertical')
export const House = icon('House')
export const Infinity = icon('Infinity')
export const Info = icon('Info')
export const Layers = icon('Layers')
export const Library = icon('Library')
export const Link2 = icon('Link2')
export const Loader2 = icon('Loader2')
export const LoaderCircle = icon('LoaderCircle')
export const Lock = icon('Lock')
export const Network = icon('Network')
export const Pencil = icon('Pencil')
export const Play = icon('Play')
export const Plus = icon('Plus')
export const Power = icon('Power')
export const RefreshCw = icon('RefreshCw')
export const Route = icon('Route')
export const Search = icon('Search')
export const Settings = icon('Settings')
export const ShieldCheck = icon('ShieldCheck')
export const Sliders = icon('Sliders')
export const Square = icon('Square')
export const Stethoscope = icon('Stethoscope')
export const Trash2 = icon('Trash2')
export const TriangleAlert = icon('TriangleAlert')
export const Upload = icon('Upload')
export const Waves = icon('Waves')
export const X = icon('X')
export const XCircle = icon('XCircle')
