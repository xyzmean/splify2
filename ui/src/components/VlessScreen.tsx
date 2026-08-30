import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import VlessPanel from '@/components/VlessPanel'
import { notify } from '@/lib/notify'
import { pending, usePending } from '@/lib/pending'
import { EMPTY_SPEC, type Output, type Spec } from '@/lib/model'

/** VLESS: откуда берутся узлы и что с ними сейчас.
 *
 *  ОДИН ВЫХОД — ОДНА ЛОКАЦИЯ. Узел выбирается у выхода, поэтому две локации одной подписки —
 *  это два выхода kind=vless на один файл узлов; в пул они потом складываются во вкладке
 *  «Выходы». Отдельной сущности «локация» в движке нет, и заводить её в интерфейсе значило бы
 *  держать своё понятие поверх чужого.
 *
 *  Источник узлов, перечень узлов и проверка живут в VlessPanel — той же самой, что и раньше:
 *  два места, спрашивающие у движка узлы, разошлись бы уже на выбранном номере. */

const SUB_FILE = '/etc/steer/sub.txt'

export default function VlessScreen() {
    const [spec, setSpec] = useState<Spec | null>(null)
    const { applied } = usePending()
    const saved = new Set(Object.keys(applied?.outputs || {}))

    useEffect(() => {
        pending.load().then(setSpec).catch(() => setSpec(EMPTY_SPEC))
    }, [])

    function edit(next: Spec) {
        setSpec(next)
        pending.edit(next)
    }

    function patch(name: string, o: Output) {
        if (!spec) return
        edit({ ...spec, outputs: { ...spec.outputs, [name]: o } })
    }

    function add() {
        if (!spec) return
        let name = 'vless'
        let n = 2
        while (spec.outputs[name]) name = `vless${n++}`
        edit({
            ...spec,
            outputs: {
                ...spec.outputs,
                [name]: { name, kind: 'vless', sub_file: SUB_FILE, node: -1, on_fail: 'drop' },
            },
        })
    }

    function remove(name: string) {
        if (!spec) return
        const used = spec.channels.filter((c) => c.out === name).map((c) => c.name)
        if (used.length) {
            notify(`Выход «${name}» занят правилами: ${used.join(', ')}`, 'warning')
            return
        }
        const outputs = { ...spec.outputs }
        delete outputs[name]
        edit({ ...spec, outputs })
    }

    if (!spec) return <div className="p-5 text-sm text-muted-foreground">Загрузка…</div>

    const vless = Object.entries(spec.outputs).filter(([, o]) => o.kind === 'vless')

    return (
        <div className="space-y-3">
            <div className="flex justify-end">
                <Button onClick={add}>
                    <Plus className="h-4 w-4" aria-hidden="true" /> Добавить локацию
                </Button>
            </div>

            {vless.length === 0 ? (
                <Card>
                    <CardHeader>
                        <CardTitle>Локаций нет</CardTitle>
                    </CardHeader>
                </Card>
            ) : (
                vless.map(([name, o]) => (
                    <Card key={name}>
                        <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                            <CardTitle>{name}</CardTitle>
                            <button
                                type="button"
                                onClick={() => remove(name)}
                                aria-label={`удалить ${name}`}
                                className="flex items-center gap-1.5 text-xs text-destructive underline decoration-dotted"
                            >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Удалить
                            </button>
                        </CardHeader>
                        <CardContent>
                            <VlessPanel
                                name={name}
                                output={o}
                                onChange={(next) => patch(name, next)}
                                saved={saved.has(name)}
                            />
                        </CardContent>
                    </Card>
                ))
            )}
        </div>
    )
}
