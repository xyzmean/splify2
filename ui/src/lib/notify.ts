/** Короткие сообщения о том, что произошло: применено, сохранено, не скачалось.
 *
 *  СВОЯ ВСПЛЫВАШКА, А НЕ ПОЛОСА LuCI. Раньше сообщения уходили в `window.ui.addNotification` —
 *  это лента наверху страницы, где каждая запись остаётся висеть, пока её не закроют вручную.
 *  Три обычных действия (применить, обновить подписку, поставить пакет) давали три полосы,
 *  которые сдвигали вниз весь пульт и требовали трёх нажатий «Dismiss». Владелец назвал это
 *  прямо: сверху выводить не нужно.
 *
 *  Поэтому всё своё: внизу по центру, само уходит, поверх страницы и без сдвига раскладки.
 *  Ошибка живёт дольше обычного сообщения — её читают, а не замечают, — и любую можно закрыть
 *  нажатием, не дожидаясь.
 *
 *  Текст приходит с роутера (слова движка, вывод менеджера пакетов, причины отказов), поэтому
 *  ставится только как ТЕКСТ: никаких innerHTML — иначе строка из ответа однажды окажется
 *  разметкой. */
export type NotifyKind = 'info' | 'warning' | 'error'

const KIND_BG: Record<NotifyKind, string> = {
  info: '#334155',
  warning: '#a97a00',
  error: '#c62842',
}

/** Сколько висит: обычное сообщение — пока читаешь, ошибка — пока успеешь понять. */
const KIND_MS: Record<NotifyKind, number> = { info: 4000, warning: 7000, error: 12000 }

const STACK_ID = 'splify2-toasts'

function stack(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  let el = document.getElementById(STACK_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = STACK_ID
  Object.assign(el.style, {
    position: 'fixed', left: '50%', bottom: '16px', transform: 'translateX(-50%)',
    zIndex: '2147483647', display: 'flex', flexDirection: 'column', gap: '8px',
    alignItems: 'center', maxWidth: 'min(92vw, 720px)', pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>)
  document.body.appendChild(el)
  return el
}

export function notify(msg: string, kind: NotifyKind = 'info') {
  const host = stack()
  if (!host) return
  const el = document.createElement('div')
  el.textContent = msg
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status')
  Object.assign(el.style, {
    pointerEvents: 'auto', cursor: 'pointer',
    maxWidth: '100%', maxHeight: '40vh', overflowY: 'auto',
    padding: '9px 14px', borderRadius: '10px',
    font: '13px/1.45 system-ui, sans-serif', color: '#fff',
    whiteSpace: 'pre-line', textAlign: 'left',
    boxShadow: '0 4px 16px rgba(0,0,0,.35)', background: KIND_BG[kind],
    opacity: '0', transition: 'opacity .18s ease',
  } satisfies Partial<CSSStyleDeclaration>)
  host.appendChild(el)
  requestAnimationFrame(() => { el.style.opacity = '1' })

  const close = () => {
    el.style.opacity = '0'
    setTimeout(() => el.remove(), 200)
  }
  el.addEventListener('click', close)
  setTimeout(close, KIND_MS[kind])
}
