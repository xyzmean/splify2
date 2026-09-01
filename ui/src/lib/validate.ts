// Field validation for the settings form.
//
// These are the same shapes the shell side enforces (common.sh's clean_ip_list
// drops anything that isn't a well-formed IPv4 prefix, splify-apply feeds them
// straight into nft sets), but there the rejection is SILENT: a typo'd subnet is
// simply dropped from the generated set and the operator sees "I added it and
// nothing happens". Catching it in the form is the whole point.

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)
const CIDR4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}/(3[0-2]|[12]?\\d)$`)

export const isIp4 = (v: string) => IPV4.test(v.trim())
/** Подсеть с длиной префикса — то, что принимает `from` канала и наборы nft. */
export const isCidr4 = (v: string) => CIDR4.test(v.trim())

export const isHttpUrl = (v: string) => {
  const s = v.trim()
  if (!s) return true            // empty = feature off, not an error
  return /^https?:\/\/[^\s]+$/i.test(s)
}

/** Источник узлов для выхода vless: ссылка на подписку ЛИБО одна или несколько ссылок
 *  vless://.
 *
 *  Две формы одного поля, а не две настройки: различает их БЭКЕНД по схеме (`sub_set` в
 *  rpcd-скрипте — ветка `https://*|http://*` скачивает, ветка `vless://*` пишет строки в файл
 *  подписки), и человек режимом не выбирает. Значит проверка здесь обязана принимать ровно то
 *  же, что принимает он: проверяя одним isHttpUrl, интерфейс отвергал ссылки vless:// до
 *  вызова rpc — то есть закрывал путь, который роутер умеет, и объяснял это словами «других
 *  схем он не умеет», неправдой про собственный бэкенд.
 *
 *  Смесь форм отвергается НАМЕРЕННО: `sub_set` идёт по одной ветке `case`, и вторую форму она
 *  молча потеряет. Тихая потеря половины ввода хуже отказа. */
export const isSubSource = (v: string) => {
  const s = v.trim()
  if (!s) return true            // пустое = «ещё не ввели»; обязательность проверяет панель
  if (isHttpUrl(s)) return true
  // Ссылок может быть несколько: из однострочного поля многострочная вставка приезжает
  // склеенной пробелами, и делит их бэкенд — здесь только проверяем, что все они vless://.
  return s.split(/\s+/).every((p) => /^vless:\/\/[^\s]+$/i.test(p))
}

