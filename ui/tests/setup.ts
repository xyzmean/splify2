import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/preact'
import { afterEach } from 'vitest'

// jsdom живёт один на весь файл, поэтому размонтирование обязательно: без него второй
// тест находит разметку первого и «проходит» по чужому DOM.
afterEach(cleanup)
