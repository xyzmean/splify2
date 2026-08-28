import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The LuCI host view (view/splify/home.js) loads this module ONCE with a stable
// URL. It must NOT be re-fetched with a cache-busting ?v= query on every visit:
// each unique URL is a distinct ES module that the browser's module registry
// retains for the whole document lifetime, so revisiting the dashboard used to
// leak an entire React bundle every time until the tab froze. Instead we expose
// window.__splifyMount; the host view calls it to (re)mount into the freshly
// created container on each visit, reusing this single module instance.
declare global {
  interface Window {
    __splifyRoot?: Root
    __splifyObserver?: MutationObserver
    __splifyMount?: (el?: HTMLElement | null) => void
    __splifyBleedOff?: () => void
  }
}

// Tear down any previous mount first — drop the old React root (running its
// effect cleanups) and the old theme observer so only one live instance exists.
function teardown() {
  if (window.__splifyRoot) { try { window.__splifyRoot.unmount() } catch { /* */ } window.__splifyRoot = undefined }
  if (window.__splifyObserver) { try { window.__splifyObserver.disconnect() } catch { /* */ } window.__splifyObserver = undefined }
  if (window.__splifyBleedOff) { try { window.__splifyBleedOff() } catch { /* */ } window.__splifyBleedOff = undefined }
}

// Sync dark mode with OpenWrt/Argon by reading the actual body background.
function syncTheme() {
  try {
    const bgColor = window.getComputedStyle(document.body).backgroundColor
    const rgb = bgColor.match(/\d+/g)
    if (rgb && rgb.length >= 3) {
      const brightness = (parseInt(rgb[0]) * 299 + parseInt(rgb[1]) * 587 + parseInt(rgb[2]) * 114) / 1000
      document.documentElement.classList.toggle('dark', brightness < 128)
    }
  } catch (e) {
    console.error('Failed to detect theme', e)
  }
}

// Сколько горизонтального отступа отбирает у нас страница LuCI.
//
// Замерено на живом роутере: `#maincontent.container` держит `padding: 0 32px`, и на телефоне
// это 64 пикселя из 390 — вместе с нашими собственными отступами под текст оставалось 264, то
// есть треть ширины экрана уходила в поля. На широком экране это ровно то, что нужно; на узком
// пульт обязан идти от края до края, как приложение, а не лежать полоской в середине.
//
// Отступ ИЗМЕРЯЕТСЯ, а не зашивается числом: 32 пикселя — значение темы bootstrap, у argon и у
// чужих тем оно своё, а отрицательный отступ больше настоящего дал бы горизонтальную прокрутку
// всей страницы. Предел в 48 пикселей — страховка от темы, у которой отступ неожиданно велик.
// Значение уезжает в переменную, а решает по ней CSS (медиазапрос в index.css): «до какой
// ширины растягиваться» — вопрос раскладки, а не разметки.
function syncBleed(root: HTMLElement) {
  try {
    let pad = 0
    let el: HTMLElement | null = root.parentElement
    while (el && el !== document.body && el !== document.documentElement) {
      pad += parseFloat(getComputedStyle(el).paddingLeft || '0') || 0
      el = el.parentElement
    }
    root.style.setProperty('--sp-bleed', `${Math.max(0, Math.min(48, Math.round(pad)))}px`)
  } catch (e) {
    console.error('Failed to measure page padding', e)
  }
}

function mount(el?: HTMLElement | null) {
  const rootElement = el ?? document.getElementById('splify-root')
  if (!rootElement) { console.error('splify-root not found!'); return }
  teardown()

  syncTheme()
  syncBleed(rootElement)
  /* Пересчёт при смене ширины: поворот телефона меняет и отступ контейнера темы. Свой
   * слушатель, а не тот же observer: тот следит за атрибутами, а не за размерами окна. */
  const onResize = () => syncBleed(rootElement)
  window.addEventListener('resize', onResize)
  window.__splifyBleedOff = () => window.removeEventListener('resize', onResize)
  const observer = new MutationObserver(syncTheme)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style', 'data-darkmode'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
  window.__splifyObserver = observer

  const root = createRoot(rootElement)
  window.__splifyRoot = root
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

window.__splifyMount = mount
mount() // first evaluation mounts into the container already in the DOM
