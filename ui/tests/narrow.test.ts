import { describe, expect, it } from 'vitest'
import { expandNarrow, normalizeSpec, type Spec } from '@/lib/model'

// Сужение подсетей по протоколу и портам — «незаметно для пользователя» (владелец).
//
// Discord у itdoginfo/allow-domains — домены плюс подсети Cloudflare, ограниченные udp и
// портами голоса. Сужение — свойство канала целиком, поэтому одним правилом это не записать:
// домены потеряли бы TCP. Интерфейс держит ОДНО правило, а в спеку пишет два: правило и
// канал-спутник с `part_of`. Сторожится:
//   1. Разворот: подсети с сужением уезжают спутником сразу за родителем, с тем же выходом и
//      клиентами; домены остаются у родителя; схема становится 2.
//   2. Свёртка: спека с диска складывается обратно в одно правило с `narrow`, и повторный
//      разворот даёт ту же спеку — иначе счётчик «Применить · N» никогда не обнулится.
//   3. Правило из одних суженных подсетей несёт сужение само, без спутника.
//   4. Без сужения спека не меняется вовсе — и схема остаётся 1.

const DISCORD_PFX = '/etc/steer/lists/itdog/discord.lst'
const DISCORD_DOM = '/etc/steer/lists/itdog/domains/discord.lst'
const NARROW = { proto: 'udp' as const, ports: ['50000-65535', '19000-20000'] }

const ui: Spec = {
    schema: 1,
    outputs: { vpn: { name: 'vpn', kind: 'direct' } },
    channels: [
        {
            name: 'Discord', out: 'vpn', from: ['192.168.1.5'],
            match: { domains_files: [DISCORD_DOM], prefixes_files: [DISCORD_PFX], mode: 'fakeip' },
            narrow: { [DISCORD_PFX]: NARROW },
        },
        { name: 'YouTube', out: 'vpn', match: { domains_files: ['/etc/steer/lists/itdog/domains/youtube.lst'] } },
    ],
}

describe('сужение подсетей — канал-спутник', () => {
    it('разворачивается в родителя и спутник, схема 2', () => {
        const disk = expandNarrow(ui)
        expect(disk.schema).toBe(2)
        expect(disk.channels.map((c) => c.name)).toEqual(['Discord', 'Discord (порты)', 'YouTube'])
        const [parent, sat] = disk.channels
        expect(parent.match.prefixes_files).toBeUndefined()
        expect(parent.match.domains_files).toEqual([DISCORD_DOM])
        expect(parent.narrow).toBeUndefined()
        expect(sat.part_of).toBe('Discord')
        expect(sat.out).toBe('vpn')
        expect(sat.from).toEqual(['192.168.1.5'])
        expect(sat.match).toEqual({ prefixes_files: [DISCORD_PFX], proto: 'udp', ports: NARROW.ports })
    })

    it('складывается обратно в одно правило, и круг замкнут', () => {
        const disk = expandNarrow(ui)
        const back = normalizeSpec(disk)
        expect(back.channels.map((c) => c.name)).toEqual(['Discord', 'YouTube'])
        expect(back.channels[0].match.prefixes_files).toEqual([DISCORD_PFX])
        expect(back.channels[0].narrow).toEqual({ [DISCORD_PFX]: NARROW })
        expect(JSON.stringify(expandNarrow(back))).toBe(JSON.stringify(disk))
    })

    it('правило из одних суженных подсетей несёт сужение само', () => {
        const only: Spec = {
            ...ui,
            channels: [{ name: 'Голос', out: 'vpn', match: { prefixes_files: [DISCORD_PFX] }, narrow: { [DISCORD_PFX]: NARROW } }],
        }
        const disk = expandNarrow(only)
        expect(disk.channels).toHaveLength(1)
        expect(disk.channels[0].match).toEqual({ prefixes_files: [DISCORD_PFX], proto: 'udp', ports: NARROW.ports })
        expect(disk.channels[0].part_of).toBeUndefined()
        // И читается обратно как правило с `narrow`, без proto/ports в match.
        const back = normalizeSpec(disk)
        expect(back.channels[0].match.proto).toBeUndefined()
        expect(back.channels[0].narrow).toEqual({ [DISCORD_PFX]: NARROW })
    })

    it('без сужения спека не трогается', () => {
        const plain: Spec = { ...ui, channels: [ui.channels[1]] }
        const disk = expandNarrow(plain)
        expect(disk.schema).toBe(1)
        expect(disk.channels).toEqual([ui.channels[1]])
    })

    it('спутник без родителя остаётся как есть — чужое правило не теряется', () => {
        const orphan: Spec = {
            ...ui, schema: 2,
            channels: [{ name: 'x (порты)', part_of: 'x', out: 'vpn', match: { prefixes_files: [DISCORD_PFX], proto: 'udp' } }],
        }
        expect(normalizeSpec(orphan).channels).toHaveLength(1)
    })
})
