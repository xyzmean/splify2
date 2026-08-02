// Лёгкая gettext-подобная обёртка без зависимостей.
//
// Зачем: раньше все русские строки были захардкожены прямо в .tsx. Это
// работало (русский — единственный целевой язык), но отсутствовал единый
// каталог: поменять формулировку означало найти её по всем компонентам, а
// po/ru/splify.po (для классической LuCI-view части) жил своей жизнью и
// быстро рассинхронизировался с React-интерфейсом.
//
// Теперь ключ = читаемый msgid (как в .po), значение = ru-перевод. Каталог
// здесь — единственный источник правды для React-стороны; po/ru/splify.po
// держим синхронно вручную (он относится к LuCI-view). t() для неизвестного
// msgid возвращает его как есть — безопасный фолбэк, чтобы пропуск строки
// через t() никогда не ломал интерфейс.
//
// Полный перенос существующих строк делается постепенно: оборачиваются новые и
// изменяемые строки плюс ключевые видимые термины. Необработанные русские
// строки в .tsx продолжают работать — t('русская строка') просто вернёт её же.

const RU: Record<string, string> = {
  // ── App.tsx (навигация) ──────────────────────────────────────────────
  'Status': 'Состояние',
  'AmneziaWG': 'AmneziaWG',
  'Remote control': 'Удалённое управление',
  'Loading splify…': 'Загрузка splify…',
  'Error:': 'Ошибка:',

  // ── StatusDashboard: hero ────────────────────────────────────────────
  'Mode': 'Режим',
  'Kill switch': 'Kill switch',
  'on': 'вкл',
  'off': 'выкл',
  'Tunnel': 'Туннель',
  'RX': 'Приём',
  'TX': 'Передача',
  'Failures': 'Сбоев',
  'Lists OK': 'Списки OK',
  'Enable': 'Включить',
  'Disable': 'Выключить',
  'Turn on split routing?': 'Включить split-маршрутизацию?',
  'Turn off split routing? All LAN traffic will go via WAN until the service re-enables it.':
    'Выключить split-маршрутизацию? Весь трафик LAN пойдёт через WAN, пока служба не включится снова.',
  'Split routing enabled': 'Split-маршрутизация включена',
  'Split routing disabled': 'Split-маршрутизация выключена',

  'stopped': 'не запущен',

  // ── диалог подтверждения ─────────────────────────────────────────────
  'Cancel': 'Отмена',
  'Confirm': 'Подтвердить',
  'Install update now?': 'Установить обновление сейчас?',
  'Fix the firewall for %s?': 'Починить firewall для %s?',

  // ── toolbar ──────────────────────────────────────────────────────────
  'Refresh': 'Обновить',
  'Re-run diagnostics': 'Перепроверить состояние и диагностику',
  'domains': 'домены',
  // Свежесть данных: живые значения тикают каждые несколько секунд, а
  // диагностика — кэшированный «обход», у него есть реальный возраст.
  'Diagnostics: refreshing…': 'Диагностика: обновляется…',
  'Diagnostics: %s old': 'Диагностика: %s назад',
  'Diagnostics: loading…': 'Диагностика: загружается…',
  'Diagnostics unavailable:': 'Диагностика недоступна:',
  'Apply': 'Применить',
  'Apply the splify configuration now': 'Применить конфигурацию splify сейчас',
  'Restart': 'Перезапустить',
  'Restart the splify service': 'Перезапустить службу splify',
  'Lists': 'Списки',
  'Update the ipsum (blocked IP) list': 'Обновить список ipsum (заблокированные IP)',
  'Update the ru/cn (direct) list': 'Обновить список ru/cn (напрямую)',
  'Update the VPN domains list': 'Обновить список VPN-доменов',
  'Configuration applied': 'Конфигурация применена',
  'Service restarted': 'Служба перезапущена',
  'ipsum updated': 'ipsum обновлён',
  'ru/cn updated': 'ru/cn обновлён',
  'domains updated': 'домены обновлены',
  'Emergency disable': 'Аварийно отключить',
  'Disable split routing now? All LAN traffic will exit via WAN until the service re-enables it (or you stop it).':
    'Отключить split-маршрутизацию сейчас? Весь трафик LAN выйдет через WAN, пока служба не включит её снова.',

  // ── first-run ────────────────────────────────────────────────────────
  "Let's connect the first tunnel": 'Подключим первый туннель',
  'No tunnels yet, so all LAN traffic currently goes through plain WAN.':
    'Туннелей пока нет, поэтому весь трафик LAN сейчас идёт через обычный WAN.',

  // ── Путь трафика (классы трафика) ────────────────────────────────────
  'Traffic path': 'Путь трафика',
  'Internet': 'Интернет',
  'Blocked sites': 'Заблокированные сайты',
  'RU / neutral': 'Российский / нейтральный',
  'Other traffic': 'Прочий трафик',
  'via VPN': 'через VPN',
  'via WAN': 'через WAN',
  'Direct (WAN)': 'напрямую (WAN)',
  'Open (WAN)': 'открыто (WAN)',
  'DPI bypass (zapret)': 'обход DPI (zapret)',
  'Blocked — kill switch': 'заблокировано — kill switch',
  'none': 'нет',

  // ── Списки ───────────────────────────────────────────────────────────
  'List': 'Список',
  'Entries': 'Записей',
  'Min': 'Мин',
  'Age': 'Возраст',
  'State': 'Состояние',

  // ── Туннели ──────────────────────────────────────────────────────────
  'Tunnels (failover)': 'Туннели (failover)',
  'absent': 'нет',
  'online': 'онлайн',
  'Prio': 'Приоритет',
  'Handshake': 'Связь',
  'Traffic': 'Трафик',
  'Health': 'Состояние',
  'ок': 'ок',
  'простой': 'простой',
  'Zone': 'Зона',
  'Masq': 'Masq',
  'Masquerade (masq) hides LAN behind the tunnel IP': 'Masquerade (masq) прячет LAN за IP-адресом туннеля',
  'LAN fwd': 'LAN-fwd',
  'Forwarding lan → tunnel is required for traffic to reach the tunnel':
    'Форвардинг lan → туннель нужен, чтобы трафик дошёл до туннеля',

  // ── диагностика / события ────────────────────────────────────────────
  'Diagnostics': 'Диагностика',
  'No problems detected.': 'Проблем не обнаружено.',
  'Fix': 'Исправить',
  'Create/repair the firewall zone for “%s” (accept-all + masquerading + lan↔tunnel↔wan forwarding) and reload the firewall?':
    'Создать/починить firewall-зону для «%s» (accept-all + masquerade + форвардинг lan↔туннель↔wan) и перезагрузить firewall?',
  'Firewall fixed for %s': 'Firewall починен для %s',
  'Could not fix firewall for %s': 'Не удалось починить firewall для %s',
  'Firewall fix error:': 'Ошибка firewall-fix:',
  'Event history': 'История событий',
  'No failover events recorded yet.': 'Событий переключения пока не зафиксировано.',

  // ── термины-подсказки ────────────────────────────────────────────────
  'DPI bypass hint': 'обход блокировок провайдера на уровне пакетов (DPI)',
  'Kill switch hint': 'сбрасывать трафик вместо утечки в WAN, когда все туннели упали',
  'Failover hint': 'автопереключение на резервный туннель при сбое',

  // ── WgPanel ──────────────────────────────────────────────────────────
  'AmneziaWG / WireGuard settings': 'Параметры AmneziaWG / WireGuard',
  'key set': 'ключ задан',
  'no key': 'без ключа',
  'Save and reconnect': 'Сохранить и переподключить',
  'Saving…': 'Сохраняю…',
  'Endpoint (server)': 'Endpoint (сервер)',
  'port': 'порт',
  'AllowedIPs (comma-separated)': 'AllowedIPs (через запятую)',
  'Interface addresses': 'Адреса интерфейса',
  'Public key of the peer': 'Public key пира',
  'Persistent keepalive': 'Persistent keepalive',
  'AmneziaWG obfuscation — counters': 'Обфускация AmneziaWG — счётчики',
  'Junk packets (AWG 1.5): I1–I5, J1–J3': 'Junk-пакеты (AWG 1.5): I1–I5, J1–J3',
  'collapse ▲': 'свернуть ▲',
  'expand ▼': 'развернуть ▼',
  'Private key of the interface': 'Приватный ключ интерфейса',
  'Show': 'Показать',
  'Leave empty to keep the current key.': 'Оставьте поле пустым, чтобы не менять текущий ключ.',
  'Import .conf (AmneziaWG / WireGuard)': 'Импорт .conf (AmneziaWG / WireGuard)',
  'Import and reconnect': 'Импортировать и переподключить',
  'Importing…': 'Импортирую…',

  // ── ApiPanel ─────────────────────────────────────────────────────────
  'Connected': 'Подключено',
  'Agent': 'Агент',
  'running': 'работает',
  'starting': 'запускается',
  'Last poll': 'Последний опрос',
  'Node name': 'Имя ноды',
  'Save name': 'Сохранить имя',
  'Connect to the control panel': 'Подключить к панели',
  'Connect': 'Подключить',
  'Connecting…': 'Подключаю…',
  'Re-register': 'Перерегистрировать',
  'Outbound agent (CGNAT / down tunnel)': 'Исходящий агент (CGNAT / упавший туннель)',
  'Save addresses': 'Сохранить адреса',
  'Inbound REST API (LAN / WG)': 'Входящий REST API (LAN / WG)',
  'Change': 'Сменить',
  'Retry': 'Повторить',
  'Show token': 'Показать токен',
  'Hide token': 'Скрыть токен',
  'Toggle outbound agent': 'Переключить исходящего агента',
  'Toggle inbound REST API': 'Переключить входящий REST API',


  // ── Дашборд после редизайна: сначала простой ответ, потом термины ─────
  // Уровни серьёзности словами: раньше на странице печаталось сырое
  // OK/WARN/FIXABLE/FAIL — владельцу роутера это не говорит, надо ли ему
  // что-то делать.
  'sev.OK': 'норма',
  'sev.WARN': 'внимание',
  'sev.FIXABLE': 'исправимо',
  'sev.FAIL': 'не работает',

  // Главный ответ страницы
  'Protected': 'Защита работает',
  'Blocked sites go through the tunnel %s. Everything else goes direct, at full speed.':
    'Заблокированные сайты идут через туннель %s. Остальное — напрямую, на полной скорости.',
  'All traffic goes through the tunnel %s; the exceptions from your lists go direct.':
    'Весь трафик идёт через туннель %s, исключения из ваших списков — напрямую.',
  'No tunnel — DPI bypass is carrying it': 'Туннеля нет — работает обход блокировок',
  'Every tunnel is unreachable, so blocked sites are being opened by %s instead. That works, but it is slower and less reliable than a tunnel.':
    'Ни один туннель не доступен, поэтому заблокированные сайты открывает %s. Это работает, но медленнее и менее надёжно, чем туннель.',
  'Traffic blocked (kill switch)': 'Трафик заблокирован (kill switch)',
  'No tunnel is available, and because the kill switch is on, traffic that should be protected is dropped instead of leaking to the open internet.':
    'Доступного туннеля нет, а kill switch включён — поэтому трафик, который должен быть защищён, отбрасывается, а не уходит в открытый интернет.',
  'Protection is off': 'Защита выключена',
  'Everything goes straight to the internet through your provider — nothing is routed through a tunnel.':
    'Весь трафик идёт напрямую через вашего провайдера — ничего не направляется в туннель.',
  'Turn on protection': 'Включить защиту',
  'Turn off protection': 'Выключить защиту',
  'Turn off protection?': 'Выключить защиту?',

  // Строка «признаков жизни» под главным ответом
  'Live speed through the tunnels': 'Текущая скорость через туннели',
  'handshake': 'связь',
  'Handshake hint': 'когда туннель последний раз обменивался пакетами с сервером; свежее 3 минут — живой',
  'DPI bypass': 'Обход блокировок',
  'not installed': 'не установлен',
  'mode.blocklist': 'через VPN только заблокированное',
  'mode.full': 'всё через VPN',
  'mode.split': 'только выбранные списки',

  // Куда идёт трафик
  'Where your traffic goes': 'Куда идёт ваш трафик',
  'addresses from the blocked-IP list': 'адреса из списка заблокированных',
  'Russian sites': 'Российские сайты',
  'from the RU/CN list — banks, government, local services':
    'из списка RU/CN — банки, госуслуги, местные сервисы',
  'Everything else': 'Всё остальное',
  'ordinary sites and apps': 'обычные сайты и приложения',
  'in full mode this rides the tunnel too': 'в режиме «всё через VPN» тоже идёт в туннель',
  'through %s': 'через %s',
  'full provider speed': 'полная скорость провайдера',
  'may be unreachable': 'может не открываться',
  'Your devices': 'Ваши устройства',

  // Что требует внимания
  'What needs attention': 'Что требует внимания',
  'Everything is in order.': 'Всё в порядке.',

  // Действия
  'Apply settings': 'Применить настройки',
  // Баннер обновления оставался по-английски.
  'Update available:': 'Доступно обновление:',
  'Install': 'Установить',
  'Install update now? This will download and install the latest version in the background. The router might momentarily disconnect.':
    'Установить обновление сейчас? Последняя версия скачается и установится в фоне; роутер может на короткое время потерять связь.',
  'Update started in the background': 'Обновление запущено в фоне',
  'Maintenance': 'Обслуживание',
  'lists refresh themselves daily': 'списки обновляются сами раз в сутки',
  'Restart service': 'Перезапустить службу',
  'Refresh blocked-IP list': 'Обновить список заблокированных',
  'Refresh RU list': 'Обновить список RU/CN',
  'Refresh domain list': 'Обновить список доменов',
  'Lists refresh themselves daily; these buttons are for when you do not want to wait.':
    'Списки обновляются сами раз в сутки — эти кнопки нужны, если ждать не хочется.',

  // Подробности (раскрывающиеся блоки)
  'Tunnels': 'Туннели',
  'in order': 'в порядке',
  'last: %s': 'последнее: %s',
  'Priority hint': 'меньше номер — выше приоритет; трафик берёт первый живой туннель',
  'Zone hint': 'firewall-зона, в которой находится туннель',
  'list.ipsum': 'Заблокированные IP',
  'list.ru': 'Сети RU/CN',
  'list.nozapret': 'Исключения обхода DPI',
  'list.hint.ipsum': 'ipsum — адреса, которые направляются в туннель',
  'list.hint.ru': 'ru/cn — адреса, которые всегда идут напрямую',
  'list.hint.nozapret': 'nozapret — адреса, которые обход DPI не должен трогать',
  'Lists explainer': 'Записи — сколько адресов в списке, «Мин» — порог, ниже которого список считается битым.',

  // ── SettingsPage ─────────────────────────────────────────────────────
  'Delete': 'Удалить',
  'Add': 'Добавить',
}

/**
 * Перевести msgid на русский. Неизвестный msgid возвращается как есть —
 * поэтому t('уже русская строка') безопасно вернёт её же (для ещё не
 * перенесённых строк), а t('english') без записи в словаре покажет английский.
 */
export function t(msgid: string): string {
  return RU[msgid] ?? msgid
}

// ── диагностика: перевод находок splify-doctor ────────────────────────────────
//
// Сообщения приходят из shell на английском и остаются такими в REST API и у
// агента (машинный интерфейс должен быть стабильным и одноязычным). А на
// странице их читает владелец роутера — и это как раз те строки, по которым он
// решает, что делать. Поэтому переводим на клиенте: список пар
// «регулярное выражение → шаблон» с подстановкой $1..$3.
//
// Незнакомое сообщение возвращается как есть — новая проверка в doctor никогда
// не ломает страницу, просто показывается по-английски, пока сюда не добавят
// правило.
const CHECK_PATTERNS: [RegExp, string][] = [
  // config
  [/^no failover tunnels configured$/, 'Туннели не настроены'],
  [/^LAN subnet not set or not detected on '(.+?)' — no policy chains, all LAN traffic exits WAN$/,
   'Подсеть LAN не задана и не определена на «$1» — правила маршрутизации не создаются, весь трафик уходит в WAN'],
  // endpoints
  [/^(.+?): configured but down \(no kernel link\)$/, '$1: настроен, но не поднят'],
  [/^(.+?): interface does not exist \(not configured in \/etc\/config\/network\)$/,
   '$1: интерфейса не существует — создайте его в Сеть → Интерфейсы'],
  [/^(.+?): route_allowed_ips not 0 on a peer \(would hijack main routes when brought up\)$/,
   '$1: у пира route_allowed_ips ≠ 0 — при поднятии туннель перехватит основные маршруты'],
  // firewall
  [/^(.+?): not in any firewall zone \(fw4 will REJECT LAN->tunnel\)$/,
   '$1: туннель не входит ни в одну зону firewall — трафик из LAN в туннель будет отброшен'],
  [/^(.+?): zone '(.+?)' has masquerading disabled$/,
   '$1: в зоне «$2» выключен masquerade — ответы не вернутся в локальную сеть'],
  [/^(.+?): no forwarding '(.+?)' -> '(.+?)' \(fw4 will REJECT LAN->tunnel\)$/,
   '$1: нет разрешения на форвардинг «$2» → «$3» — трафик из LAN в туннель будет отброшен'],
  [/^(.+?): no reverse forwarding '(.+?)' -> '(.+?)' \(fw4 will REJECT remote-initiated site-to-site traffic to LAN\)$/,
   '$1: нет обратного форвардинга «$2» → «$3» — входящий трафик site-to-site в LAN будет отброшен'],
  [/^(.+?): MSS clamping \(mtu_fix\) disabled on zone '(.+?)' — large packets stall on low-MTU tunnels$/,
   '$1: в зоне «$2» выключено подрезание MSS (mtu_fix) — большие пакеты будут зависать в туннеле'],
  [/^(.+?): zone '(.+?)' has a non-ACCEPT input\/output\/forward policy — blocks router-originated probes and site-to-site\/intra-zone traffic$/,
   '$1: в зоне «$2» политика не ACCEPT — блокируются проверки связи с роутера и трафик site-to-site'],
  [/^(.+?): is in the shared '(.+?)' \((.+?)\) firewall zone — auto-fix can't add tunnel masq\/forwarding without opening the whole \3 zone$/,
   '$1: туннель в общей зоне «$2» ($3) — автоисправление не будет менять её, иначе откроется вся зона. Дайте туннелю отдельную зону'],
  [/^(.+?): shares firewall zone '(.+?)' with non-tunnel networks — auto-fix refuses to change a mixed zone's masq\/forwarding\/policy \(site-to-site inbound stays rejected\)$/,
   '$1: зона «$2» содержит не только туннели — автоисправление её не меняет. Дайте туннелю отдельную зону'],
  [/^(.+?): not in an explicit firewall zone but matched by zone '(.+?)' via a device wildcard — verify it has masq \+ lan<->zone \+ zone->wan$/,
   '$1: попадает в зону «$2» по маске устройств — проверьте, что там есть masquerade и форвардинг lan↔зона↔wan'],
  // lists
  [/^ipsum list file not yet downloaded \((.+?)\)$/, 'Список заблокированных ещё не скачан ($1)'],
  [/^ipsum list has (\d+) prefixes \(<(\d+)\)$/,
   'В списке заблокированных всего $1 подсетей (нужно не меньше $2) — похоже, скачался неполный список'],
  [/^ipsum list is stale \((\d+)d old\)$/, 'Список заблокированных не обновлялся $1 дн.'],
  [/^ipsum list is on disk but the live nft set is empty or incomplete$/,
   'Список заблокированных есть на диске, но в ядро он не загружен — маршрутизация по нему сейчас не работает'],
  [/^ipsum list does not fit in this router's memory: (.+)$/,
   'Список заблокированных не помещается в память роутера: $1'],
  [/^ru\/cn list file not yet downloaded \((.+?)\)$/, 'Список RU/CN ещё не скачан ($1)'],
  [/^ru\/cn list has (\d+) prefixes \(<(\d+)\)$/,
   'В списке RU/CN всего $1 подсетей (нужно не меньше $2) — похоже, скачался неполный список'],
  [/^ru\/cn list is stale \((\d+)d old\)$/, 'Список RU/CN не обновлялся $1 дн.'],
  [/^ru\/cn list is on disk but the live nft set is empty or incomplete$/,
   'Список RU/CN есть на диске, но в ядро он не загружен'],
  [/^IPv6 DNS from the LAN is not redirected to splify-dnsd — clients that prefer the IPv6 resolver bypass domain routing entirely$/,
   'DNS-запросы из локальной сети по IPv6 не перенаправляются в splify-dnsd — устройства, предпочитающие IPv6-резолвер, обходят маршрутизацию по доменам'],
  // geoblock
  [/^geoblock is on but no interface is selected — those domains follow the normal path$/,
   'Geoblock включён, но интерфейс не выбран — эти домены идут обычным путём'],
  [/^geoblock interface '(.+?)' does not exist on this router$/,
   'Интерфейса «$1» на роутере нет — выберите существующий'],
  [/^geoblock interface '(.+?)' is down — those domains use the normal path until it returns$/,
   'Интерфейс «$1» не поднят — пока он лежит, эти домены идут обычным путём'],
  [/^no route for geoblock-marked traffic \(ip rule\/table (\d+) missing\)$/,
   'Для трафика geoblock нет маршрута — правило и таблица $1 не созданы'],
  [/^geoblock-marked traffic egresses '(.+?)', not the selected '(.+?)'$/,
   'Трафик geoblock уходит через «$1», а выбран «$2»'],
  [/^geoblock list is not downloaded yet \((.+?)\)$/, 'Список geoblock ещё не скачан ($1)'],
  [/^geoblock list is stale \((\d+)d old\)$/, 'Список geoblock не обновлялся $1 дн.'],
  [/^geoblock set \((.+?)\) is missing from the live ruleset — nothing gets marked$/,
   'Набора $1 нет в живых правилах — трафик geoblock не размечается'],
  [/^geoblock mark rule missing from the live ruleset$/,
   'В живых правилах нет правила разметки geoblock'],
  [/^geoblock domains are not in the daemon's rule file \((.+?)\)$/,
   'Домены geoblock не попали в файл правил демона ($1)'],
  [/^geoblock: (\d+) domains routed via (.+)$/, 'Geoblock: $1 домен(ов) через «$2»'],
  [/^geoblock is routed via dnsmasq nftset — install splify-dns for per-domain \(fake-IP\) accuracy on shared CDN addresses$/,
   'Geoblock работает через dnsmasq nftset: домены на общем адресе CDN попадут в туннель все вместе. Установите splify-dns для точности по доменам'],
  // zapret
  [/^zapret is enabled in splify but not installed \(auto-skipped\)$/,
   'Обход блокировок включён в настройках, но пакет zapret не установлен — шаг пропускается'],
  [/^zapret is installed but not running$/, 'zapret установлен, но не запущен'],
  [/^nozapret bypass set is empty or incomplete$/,
   'Список исключений обхода DPI пуст или неполон — обход может трогать трафик, который должен идти напрямую'],
  [/^nozapret bypass could not be refreshed: (.+)$/, 'Не удалось обновить исключения обхода DPI: $1'],
  // routing
  [/^anti-loop ip rule \(prio (\d+), fwmark -> main\) missing or malformed$/,
   'Потерялось правило маршрутизации против петель (приоритет $1) — перезапустите службу'],
  [/^wg fwmark ip rule \(prio (\d+) -> table (\d+)\) missing or malformed while active path is VPN$/,
   'Потерялось правило, направляющее помеченный трафик в туннель (приоритет $1, таблица $2) — перезапустите службу'],
  [/^table (\d+) has no default route while active path is VPN$/,
   'В таблице маршрутов $1 нет маршрута по умолчанию, хотя активен VPN'],
  [/^table (\d+) default route is not via active iface '(.+?)'$/,
   'Маршрут по умолчанию в таблице $1 идёт не через активный туннель «$2»'],
  [/^table (\d+) default is blackholed but state says VPN \((.+?)\)$/,
   'В таблице $1 трафик отбрасывается, хотя состояние — VPN ($2)'],
  [/^active path is WAN\/zapret but table (\d+) still holds routes$/,
   'Активен WAN/обход DPI, но в таблице $1 остались маршруты туннеля (уйдут на следующем цикле)'],
  [/^killswitch is ON but active path is '(.+?)' \(policy traffic on WAN instead of blackholed\)$/,
   'Kill switch включён, но трафик идёт через «$1» вместо блокировки'],
  [/^killswitch active but table (\d+) default is not a blackhole \(traffic may leak\)$/,
   'Kill switch активен, но в таблице $1 нет блокирующего маршрута — трафик может утекать'],
  [/^killswitch active but wg fwmark ip rule \(prio (\d+) -> table (\d+)\) missing\/malformed — marked traffic bypasses the blackhole to WAN$/,
   'Kill switch активен, но правило (приоритет $1 → таблица $2) потерялось — помеченный трафик уходит в WAN'],
  [/^VPN subnet (.+?) \(site-to-site\) is missing from the live VPN set \((.+?)\) — its traffic is never marked for the tunnel$/,
   'Подсеть $1 отсутствует в живом наборе $2 — её трафик не помечается для туннеля. Нажмите «Применить настройки»'],
  [/^VPN subnet (.+?) \(site-to-site\) not routed into the tunnel — marked traffic egresses '(.+?)', not '(.+?)'$/,
   'Подсеть $1 не заходит в туннель — помеченный трафик уходит через «$2», а не «$3»'],
  [/^Direct subnet (.+?) is missing from the live direct set \((.+?)\)$/,
   'Подсеть $1 отсутствует в наборе «напрямую» ($2) — нажмите «Применить настройки»'],
  [/^device (.+?) \((.+?)\) is missing from device routing rules$/,
   'Правило для устройства $1 ($2) не установлено — нажмите «Применить настройки»'],
  [/^device (.+?) is invalid CIDR$/, 'Адрес устройства $1 указан неверно'],
  [/^skipped the site-to-site set-membership check: reading the nft set needs more memory than this router has free$/,
   'Проверка подсетей site-to-site пропущена: чтение набора требует больше памяти, чем свободно на роутере'],
  // dnsmasq
  [/^VPN domains URL set but the list is not downloaded yet \((.+?)\)$/,
   'Указан URL списка доменов для VPN, но список ещё не скачан ($1)'],
  [/^ignore\/direct domains URL set but the list is not downloaded yet \((.+?)\)$/,
   'Указан URL списка доменов «напрямую», но список ещё не скачан ($1)'],
  [/^domain tagging configured but the dnsmasq nftset drop-in is missing from (.+)$/,
   'Маршрутизация по доменам настроена, но правила для dnsmasq отсутствуют в $1 — нажмите «Применить настройки»'],
  // agent / singbox
  [/^remote control agent is enabled but not running$/, 'Агент удалённого управления включён, но не запущен'],
  [/^remote control agent is running$/, 'Агент удалённого управления работает'],
  [/^sing-box endpoint\(s\) configured but the sing-box package is not installed$/,
   'Настроены туннели sing-box, но пакет sing-box не установлен'],
]

// Подсказки «что делать» из doctor — короткие, поэтому отдельным словарём.
const FIX_PATTERNS: [RegExp, string][] = [
  [/^add a tunnel under Services -> splify \(Failover tunnels\)$/, 'Добавьте туннель на вкладке «Дополнительно» → «Туннели»'],
  [/^set the LAN subnet \(CIDR\) or fix the LAN interface in Services -> splify$/,
   'Укажите подсеть LAN или исправьте LAN-интерфейс в «Дополнительно» → «LAN»'],
  [/^create it under Network -> Interfaces, or remove it from splify$/,
   'Создайте интерфейс в Сеть → Интерфейсы или удалите его из splify'],
  [/^failover will bring it up, or run: ifup (.+)$/, 'Служба поднимет его сама на следующем цикле'],
  [/^run splify-apply \(forces route_allowed_ips=0\)$/, 'Нажмите «Применить настройки»'],
  [/^run splify-apply$/, 'Нажмите «Применить настройки»'],
  [/^run splify-apply \(rebuilds the VPN set \+ routes\)$/, 'Нажмите «Применить настройки»'],
  [/^run splify-apply \(regenerates and reloads dnsmasq\)$/, 'Нажмите «Применить настройки»'],
  [/^restart the service: \/etc\/init\.d\/splify restart$/, 'Нажмите «Перезапустить службу» в блоке «Обслуживание»'],
  [/^splify-firewall fix (.+)$/, 'Нажмите «Исправить» в этой строке'],
  [/^add '(.+?)' to a firewall zone with masq=1$/, 'Нажмите «Исправить» — splify создаст зону сам'],
  [/^enable masq on firewall zone '(.+?)'$/, 'Нажмите «Исправить» — splify включит masquerade в зоне «$1»'],
  [/^add firewall forwarding src='(.+?)' dest='(.+?)'$/, 'Нажмите «Исправить» — splify добавит форвардинг «$1» → «$2»'],
  [/^give (.+?) its own firewall zone, then run: splify-firewall fix \1$/,
   'Дайте туннелю $1 отдельную зону firewall, затем нажмите «Исправить»'],
  [/^splify-update-ipsum, or it reloads on the next failover tick$/,
   'Нажмите «Обновить список заблокированных» в блоке «Обслуживание»'],
  [/^splify-update-ipsum$/, 'Нажмите «Обновить список заблокированных» в блоке «Обслуживание»'],
  [/^splify-update-ru, or it reloads on the next failover tick$/,
   'Нажмите «Обновить список RU/CN» в блоке «Обслуживание»'],
  [/^splify-update-ru$/, 'Нажмите «Обновить список RU/CN» в блоке «Обслуживание»'],
  [/^splify-update-domains$/, 'Нажмите «Обновить список доменов» в блоке «Обслуживание»'],
  [/^the next failover tick reloads it; or run splify-apply$/,
   'Загрузится на следующем цикле проверки; или нажмите «Применить настройки»'],
  [/^use a smaller ipsum list, route by domain instead, or disable ipsum in Services -> splify$/,
   'Возьмите список меньшего размера, маршрутизируйте по доменам или выключите ipsum в «Дополнительно» → «Списки»'],
  [/^use a smaller ru\/cn or ipsum list, or disable ipsum so the bypass fits$/,
   'Возьмите списки меньшего размера или выключите ipsum, чтобы исключения поместились'],
  [/^install zapret, or disable it in Services -> splify$/,
   'Установите zapret или выключите обход DPI в «Дополнительно» → «Списки»'],
  [/^the failover loop starts it; or: (.+)$/, 'Служба запустит его на следующем цикле'],
  [/^splify-failover rebuilds it; or check the ru\/cn list$/,
   'Служба пересоберёт их на следующем цикле; либо проверьте список RU/CN'],
  [/^check why no tunnel is healthy; failover should blackhole under killswitch$/,
   'Разберитесь, почему ни один туннель не жив'],
  [/^stale; clears on next failover tick$/, 'Само очистится на следующем цикле проверки'],
  [/^run splify-failover \(one pass\) or restart the service$/, 'Нажмите «Перезапустить службу»'],
  [/^run splify-failover$/, 'Служба исправит это на следующем цикле'],
  [/^remove or fix in UI$/, 'Исправьте адрес в «Дополнительно» → «Устройства»'],
  [/^no action needed unless site-to-site traffic is actually failing$/,
   'Ничего делать не нужно, если site-to-site работает'],
  [/^\/etc\/init\.d\/splify-agent restart$/, 'Перезапустите службу splify'],
  // geoblock
  [/^pick an interface in Services -> splify$/,
   'Выберите интерфейс в «Дополнительно» → «Списки» → Geoblock'],
  [/^pick an existing interface in Services -> splify$/,
   'Выберите существующий интерфейс в «Дополнительно» → «Списки» → Geoblock'],
  [/^bring the tunnel up, or pick another interface$/,
   'Поднимите туннель или выберите другой интерфейс'],
  [/^run splify-apply, or wait for the next failover tick$/,
   'Нажмите «Применить настройки» — или само создастся на следующем цикле'],
  [/^run splify-apply \(rebuilds the geoblock rule and table (\d+)\)$/,
   'Нажмите «Применить настройки»'],
  [/^run splify-apply, then check the boot log for an nftables include error$/,
   'Нажмите «Применить настройки»; если не поможет — посмотрите в системном журнале ошибку загрузки правил nftables'],
  [/^run splify-apply \(regenerates 30-splify\.nft\)$/, 'Нажмите «Применить настройки»'],
  [/^run splify-apply \(regenerates it and reloads splify-dnsd\)$/, 'Нажмите «Применить настройки»'],
  [/^run splify-apply \(regenerates them\)$/, 'Нажмите «Применить настройки»'],
]

function applyPatterns(text: string, patterns: [RegExp, string][]): string {
  for (const [re, template] of patterns) {
    const m = re.exec(text)
    if (m) return template.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '')
  }
  return text
}

/** Перевести сообщение находки doctor. Неизвестное — как есть. */
export const tCheck = (msg: string) => applyPatterns(msg, CHECK_PATTERNS)
/** Перевести подсказку «что делать». Неизвестную — как есть. */
export const tFix = (fix: string) => applyPatterns(fix, FIX_PATTERNS)
