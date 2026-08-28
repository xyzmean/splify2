import EngineCard from '@/components/EngineCard'
import SelfUpdateCard from '@/components/SelfUpdateCard'
import BackupCard from '@/components/BackupCard'
import { type Live } from '@/lib/live'

/** Система: пакеты и архив настроек — то, что относится к коробке целиком, а не к
 *  маршрутизации.
 *
 *  Прежде все три карточки жили в конце вкладки «Логи steer», ниже диагностики и счётчиков.
 *  Найти там установку движка можно было только прокруткой, а название вкладки о её содержимом
 *  не говорило ничего. Архив настроек до этого стоял и вовсе под пультом на КАЖДОМ экране —
 *  постоянное место ради действия, которое делают раз в жизни.
 *
 *  Прежний довод («архив нужен и когда настройка ещё не работает, чтобы перенести её на новый
 *  роутер») никуда не делся и выполняется: раздел доступен всегда. */

export default function System({ live }: { live: Live }) {
    return (
        <div className="space-y-4">
            <p className="text-[13px] text-muted-foreground">Пакеты и архив настроек.</p>
            <EngineCard engine={live.build} releases={live.releases} onInstalled={live.refresh} />
            <SelfUpdateCard info={live.selfUpdate} onInstalled={live.refresh} />
            <BackupCard />
        </div>
    )
}
