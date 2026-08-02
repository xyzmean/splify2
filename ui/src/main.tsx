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
  }
}

// Tear down any previous mount first — drop the old React root (running its
// effect cleanups) and the old theme observer so only one live instance exists.
function teardown() {
  if (window.__splifyRoot) { try { window.__splifyRoot.unmount() } catch { /* */ } window.__splifyRoot = undefined }
  if (window.__splifyObserver) { try { window.__splifyObserver.disconnect() } catch { /* */ } window.__splifyObserver = undefined }
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

function mount(el?: HTMLElement | null) {
  const rootElement = el ?? document.getElementById('splify-root')
  if (!rootElement) { console.error('splify-root not found!'); return }
  teardown()

  syncTheme()
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
