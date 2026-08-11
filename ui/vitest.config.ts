import path from 'path'
import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vite.config'

// Стенд интерфейса.
//
// Конфигурация НЕ своя, а надстройка над сборочной: alias наследуется целиком, включая
// подмену react → preact/compat. Это принципиально — в пакет уезжает preact, и стенд,
// проверяющий react, проверял бы не то, что стоит на роутере. Расхождение такого рода уже
// стоило проекту находки I-024 («локально зелено, релиз сломан»).
//
// Единственное исключение — иконки: почему они подменены, написано в самой заглушке.
export default mergeConfig(
    base,
    defineConfig({
        resolve: {
            alias: {
                'lucide-react': path.resolve(__dirname, './tests/stub/lucide-react.tsx'),
            },
        },
        test: {
            environment: 'jsdom',
            globals: true,
            include: ['tests/**/*.test.{ts,tsx}'],
            setupFiles: ['./tests/setup.ts'],
        },
    }),
)
