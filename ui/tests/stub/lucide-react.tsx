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
 *  Список ниже — те иконки, которые интерфейс действительно импортирует. Появится новая —
 *  стенд упадёт на «не экспортируется», и её надо дописать сюда. Это дешевле молчаливого
 *  undefined на месте компонента.
 */
type Props = Record<string, unknown>

const icon = (name: string) =>
    function Icon(props: Props) {
        return <svg data-icon={name} {...props} />
    }

export const Activity = icon('Activity')
export const AlertTriangle = icon('AlertTriangle')
export const ArrowDown = icon('ArrowDown')
export const ArrowLeft = icon('ArrowLeft')
export const ArrowUp = icon('ArrowUp')
export const Check = icon('Check')
export const Cpu = icon('Cpu')
export const Download = icon('Download')
export const Gauge = icon('Gauge')
export const Info = icon('Info')
export const Loader2 = icon('Loader2')
export const Pencil = icon('Pencil')
export const Plus = icon('Plus')
export const RefreshCw = icon('RefreshCw')
export const Search = icon('Search')
export const Trash2 = icon('Trash2')
export const TriangleAlert = icon('TriangleAlert')
export const Upload = icon('Upload')
export const XCircle = icon('XCircle')
