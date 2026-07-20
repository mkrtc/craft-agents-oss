import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import { ArrowRight, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { useRegisterModal } from '@/context/ModalContext'
import { buildContinueWithTargets, getModelId, getModelName } from './continue-with-utils'

export interface ContinueWithDialogProps {
  open: boolean
  connections: readonly LlmConnectionWithStatus[]
  currentConnectionSlug?: string
  sourceIsProcessing?: boolean
  onOpenChange: (open: boolean) => void
  onContinue: (connectionSlug: string, model: string) => Promise<void>
}

export function ContinueWithDialog({
  open,
  connections,
  currentConnectionSlug,
  sourceIsProcessing = false,
  onOpenChange,
  onContinue,
}: ContinueWithDialogProps) {
  const { t } = useTranslation()
  const targets = React.useMemo(
    () => buildContinueWithTargets(connections, currentConnectionSlug),
    [connections, currentConnectionSlug],
  )
  const [connectionSlug, setConnectionSlug] = React.useState('')
  const [model, setModel] = React.useState('')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const selectedTarget = targets.find(target => target.connection.slug === connectionSlug)

  React.useEffect(() => {
    if (!open) return
    const firstTarget = targets[0]
    const defaultModel = firstTarget?.connection.defaultModel
    const firstModel = firstTarget?.models[0] ? getModelId(firstTarget.models[0]) : ''
    setConnectionSlug(firstTarget?.connection.slug ?? '')
    setModel(
      defaultModel && firstTarget?.models.some(candidate => getModelId(candidate) === defaultModel)
        ? defaultModel
        : firstModel,
    )
    setIsSubmitting(false)
    setError(null)
  }, [open, targets])

  const close = React.useCallback(() => {
    if (!isSubmitting) onOpenChange(false)
  }, [isSubmitting, onOpenChange])
  useRegisterModal(open, close)

  const handleConnectionChange = (nextSlug: string) => {
    const target = targets.find(candidate => candidate.connection.slug === nextSlug)
    const defaultModel = target?.connection.defaultModel
    const firstModel = target?.models[0] ? getModelId(target.models[0]) : ''
    setConnectionSlug(nextSlug)
    setModel(
      defaultModel && target?.models.some(candidate => getModelId(candidate) === defaultModel)
        ? defaultModel
        : firstModel,
    )
    setError(null)
  }

  const canSubmit = !!connectionSlug && !!model && !sourceIsProcessing && !isSubmitting

  const handleSubmit = async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    setError(null)
    try {
      await onContinue(connectionSlug, model)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('chat.continueWith.genericError'))
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('chat.continueWith.title')}</DialogTitle>
          <DialogDescription>{t('chat.continueWith.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="continue-with-connection">{t('chat.continueWith.connection')}</Label>
            <Select value={connectionSlug} onValueChange={handleConnectionChange} disabled={isSubmitting}>
              <SelectTrigger id="continue-with-connection">
                <SelectValue placeholder={t('chat.continueWith.selectConnection')} />
              </SelectTrigger>
              <SelectContent layer="modal">
                {targets.map(target => (
                  <SelectItem key={target.connection.slug} value={target.connection.slug}>
                    <span className="flex items-center gap-2">
                      <ConnectionIcon connection={target.connection} size={14} />
                      {target.connection.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="continue-with-model">{t('common.model')}</Label>
            <Select value={model} onValueChange={setModel} disabled={isSubmitting || !selectedTarget}>
              <SelectTrigger id="continue-with-model">
                <SelectValue placeholder={t('chat.continueWith.selectModel')} />
              </SelectTrigger>
              <SelectContent layer="modal">
                {selectedTarget?.models.map(candidate => {
                  const id = getModelId(candidate)
                  return <SelectItem key={id} value={id}>{getModelName(candidate)}</SelectItem>
                })}
              </SelectContent>
            </Select>
          </div>

          <div className="rounded-lg border border-border/60 bg-foreground/[0.025] px-3 py-2.5 text-xs text-muted-foreground">
            {t('chat.continueWith.contextNote')}
          </div>

          {sourceIsProcessing && (
            <p className="text-sm text-amber-600 dark:text-amber-400">{t('chat.continueWith.processing')}</p>
          )}
          {targets.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('chat.continueWith.noConnections')}</p>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={isSubmitting} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {t('chat.continueWith.preparing')}
              </>
            ) : (
              <>
                {t('chat.continueWith.continue')}
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
