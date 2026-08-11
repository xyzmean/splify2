import EngineCard from '@/components/EngineCard'
import { type Live } from '@/lib/live'

/** Первый экран у беты: движка нет.
 *
 *  Показывается ВМЕСТО вкладок, а не рядом с ними. Прежде интерфейс в этом случае открывал
 *  мастер, где половина шагов не могла подействовать: без движка нечем ни проверить настройку,
 *  ни применить её. Человек заполнял подписку, нажимал «Применить» и получал отказ на последнем
 *  шаге — то есть узнавал причину после всей работы, а не до.
 *
 *  Выбор варианта сборки остаётся человеку: зависимость apk умеет только «нужен steer», и
 *  угадав за него, мы либо кладём лишний мегабайт, либо не кладём VLESS и получаем «outbound не
 *  работает» уже после настройки всего остального. Поэтому объяснение стоит РЯДОМ с выбором. */
export default function FirstRun({ live }: { live: Live }) {
    return (
        <div className="sp-root text-foreground">
            <div className="mx-auto max-w-2xl space-y-4">
                <div className="rounded-md border border-border bg-card p-5 shadow-card">
                    <h1 className="text-lg font-semibold">Движок не установлен</h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        splify2 — это интерфейс, а маршрутизацией занимается <b>steer</b>: он превращает
                        правила в собственную таблицу nftables и раздаёт метки. Без него интерфейсу нечего
                        ни проверить, ни применить, поэтому начинать надо отсюда.
                    </p>
                    <ul className="mt-3 space-y-1.5 text-sm">
                        <li>
                            <b>extended</b>
                            <span className="text-muted-foreground">
                                {' '}— поднимает VLESS/Reality сам, достаточно подписки. Нужен, если туннеля
                                на роутере ещё нет.
                            </span>
                        </li>
                        <li>
                            <b>basic</b>
                            <span className="text-muted-foreground">
                                {' '}— только маршрутизация по готовым устройствам: wireguard, amneziawg,
                                любой существующий интерфейс.
                            </span>
                        </li>
                    </ul>
                </div>

                <EngineCard engine={live.build} releases={live.releases} onInstalled={live.refresh} />

                <p className="text-xs text-muted-foreground">
                    Пакет можно поставить и руками:{' '}
                    <code className="font-mono">apk add --allow-untrusted ./steer-extended-*.apk</code>. На
                    роутере с 64 МБ перед установкой стоит остановить движок, если он уже работал: apk
                    иногда убивает нехватка памяти, и тогда обновление молча не происходит.
                </p>
            </div>
        </div>
    )
}
