import { render, screen } from '@testing-library/preact'
import { describe, expect, it } from 'vitest'

describe('стенд', () => {
    it('рисует компонент и находит его в DOM', () => {
        render(<button type="button">Обновить</button>)
        expect(screen.getByRole('button', { name: 'Обновить' })).toBeInTheDocument()
    })
})
