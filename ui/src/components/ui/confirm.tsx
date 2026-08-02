import { useCallback, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { t } from '@/lib/i18n'
import { AlertTriangle } from 'lucide-react'

// In-page confirmation instead of window.confirm().
//
// window.confirm blocks the whole browser UI with an unstyled OS dialog that
// (a) looks nothing like the rest of the page, (b) on many browsers shows the
// router's IP and an "prevent this page from creating more dialogs" checkbox
// which, once ticked, silently makes every destructive action a no-op, and
// (c) freezes the polling loop while it is open. This is the same styling as the
// rest of the app (Card + Button), keyboard-operable, and cancel-by-default.

export interface ConfirmRequest {
  title: string
  body?: string
  confirmLabel?: string
  /** destructive = red confirm button (default for the actions that use this) */
  tone?: 'destructive' | 'default'
}

type Pending = ConfirmRequest & { resolve: (ok: boolean) => void }

/**
 * Returns [ask, dialog]: `await ask({…})` resolves true/false, and `dialog`
 * must be rendered somewhere in the tree.
 */
export function useConfirm(): [(req: ConfirmRequest) => Promise<boolean>, React.ReactNode] {
  const [pending, setPending] = useState<Pending | null>(null)

  const ask = useCallback((req: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => setPending({ ...req, resolve }))
  }, [])

  const close = useCallback((ok: boolean) => {
    setPending((p) => { p?.resolve(ok); return null })
  }, [])

  const dialog = pending ? (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
      role="dialog" aria-modal="true" aria-label={pending.title}
      // Click-outside and Esc both cancel: the safe outcome is always "no".
      onClick={(e) => { if (e.target === e.currentTarget) close(false) }}
      onKeyDown={(e) => { if (e.key === 'Escape') close(false) }}
    >
      <Card className="w-full max-w-md shadow-lg">
        <CardContent className="p-5">
          <h4 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className={pending.tone === 'default' ? 'size-4 text-primary' : 'size-4 text-warning'} />
            {pending.title}
          </h4>
          {pending.body && <p className="mt-2 text-sm text-muted-foreground">{pending.body}</p>}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => close(false)}>{t('Cancel')}</Button>
            <Button
              size="sm"
              variant={pending.tone === 'default' ? 'default' : 'destructive'}
              autoFocus
              onClick={() => close(true)}
            >
              {pending.confirmLabel || t('Confirm')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  ) : null

  return [ask, dialog]
}
