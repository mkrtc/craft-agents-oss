import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { EntityColor, SystemColorName } from '@craft-agent/shared/colors'
import { resolveEntityColor } from '@craft-agent/shared/colors'
import type { CreateLabelInput, LabelConfig } from '@craft-agent/shared/labels'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ColorPicker } from '@/components/ui/color-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRegisterModal } from '@/context/ModalContext'
import { useTheme } from '@/context/ThemeContext'
import { buildLabelParentOptions, resolveInitialParentId } from './create-label-utils'

const ROOT_PARENT = '__root__'
const CUSTOM_COLOR = '__custom__'
const DEFAULT_CUSTOM_COLOR = '#6366f1'
const SYSTEM_COLORS: readonly SystemColorName[] = ['accent', 'info', 'success', 'destructive', 'foreground']
type LabelValueType = 'boolean' | 'string' | 'number' | 'date' | 'link'

export interface CreateLabelDialogProps {
  open: boolean
  workspaceId?: string
  labels: readonly LabelConfig[]
  initialName?: string
  defaultParentId?: string
  onOpenChange: (open: boolean) => void
  onCreated?: (label: LabelConfig) => void
  /** Injectable for playground/tests; production defaults to the Electron RPC. */
  createLabel?: (workspaceId: string, input: CreateLabelInput) => Promise<LabelConfig>
}

export function CreateLabelDialog({
  open,
  workspaceId,
  labels,
  initialName = '',
  defaultParentId,
  onOpenChange,
  onCreated,
  createLabel,
}: CreateLabelDialogProps) {
  const { t } = useTranslation()
  const { isDark } = useTheme()
  const parentOptions = React.useMemo(() => buildLabelParentOptions(labels), [labels])
  const [name, setName] = React.useState(initialName)
  const [parentId, setParentId] = React.useState(ROOT_PARENT)
  const [colorChoice, setColorChoice] = React.useState<string>('accent')
  const [customColor, setCustomColor] = React.useState(DEFAULT_CUSTOM_COLOR)
  const [valueType, setValueType] = React.useState<LabelValueType>('boolean')
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const close = React.useCallback(() => {
    if (!isSubmitting) onOpenChange(false)
  }, [isSubmitting, onOpenChange])
  useRegisterModal(open, close)

  React.useEffect(() => {
    if (!open) return
    setName(initialName)
    setParentId(resolveInitialParentId(parentOptions, defaultParentId) ?? ROOT_PARENT)
    setColorChoice('accent')
    setCustomColor(DEFAULT_CUSTOM_COLOR)
    setValueType('boolean')
    setIsSubmitting(false)
    setError(null)
  }, [open, initialName, defaultParentId, parentOptions])

  const trimmedName = name.trim()
  const canSubmit = !!workspaceId && trimmedName.length > 0 && !isSubmitting
  const selectedColor: EntityColor = colorChoice === CUSTOM_COLOR
    ? { light: customColor }
    : colorChoice as SystemColorName
  const resolvedColor = resolveEntityColor(selectedColor, isDark)

  const handleSubmit = async () => {
    if (!canSubmit || !workspaceId) return
    setIsSubmitting(true)
    setError(null)
    try {
      const create = createLabel ?? ((id: string, input: CreateLabelInput) => window.electronAPI.createLabel(id, input))
      const created = await create(workspaceId, {
        name: trimmedName,
        color: selectedColor,
        parentId: parentId === ROOT_PARENT ? undefined : parentId,
        valueType: valueType === 'boolean' ? undefined : valueType,
      })
      onCreated?.(created)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('labels.createDialog.genericError'))
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && close()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('labels.createDialog.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="create-label-name">{t('labels.createDialog.name')}</Label>
            <Input
              id="create-label-name"
              autoFocus
              value={name}
              disabled={isSubmitting}
              placeholder={t('labels.createDialog.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canSubmit) {
                  event.preventDefault()
                  void handleSubmit()
                }
              }}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-label-parent">{t('labels.createDialog.parent')}</Label>
            <Select value={parentId} onValueChange={setParentId} disabled={isSubmitting}>
              <SelectTrigger id="create-label-parent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT_PARENT}>{t('labels.createDialog.noParent')}</SelectItem>
                {parentOptions.map(option => (
                  <SelectItem key={option.id} value={option.id} disabled={option.disabled}>
                    {option.label}{option.disabled ? ` — ${t('labels.createDialog.maxDepth')}` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>{t('labels.createDialog.color')}</Label>
            <div className="flex items-center gap-2">
              {SYSTEM_COLORS.map(color => {
                const swatch = resolveEntityColor(color, isDark)
                const selected = colorChoice === color
                return (
                  <button
                    key={color}
                    type="button"
                    disabled={isSubmitting}
                    aria-label={t('labels.createDialog.selectColor', { color })}
                    aria-pressed={selected}
                    onClick={() => setColorChoice(color)}
                    className="h-7 w-7 rounded-full border-2 transition-transform hover:scale-110 disabled:opacity-50"
                    style={{ backgroundColor: swatch, borderColor: selected ? 'var(--foreground)' : 'transparent' }}
                  />
                )
              })}
              <ColorPicker
                value={customColor}
                onChange={(hex) => { setCustomColor(hex); setColorChoice(CUSTOM_COLOR) }}
                ariaLabel={t('labels.createDialog.customColor')}
                trigger={(
                  <button
                    type="button"
                    disabled={isSubmitting}
                    aria-label={t('labels.createDialog.customColor')}
                    aria-pressed={colorChoice === CUSTOM_COLOR}
                    className="h-7 w-7 rounded-full border-2 border-dashed transition-transform hover:scale-110 disabled:opacity-50"
                    style={{ backgroundColor: customColor, borderColor: colorChoice === CUSTOM_COLOR ? 'var(--foreground)' : 'var(--border)' }}
                  />
                )}
              />
              <span className="ml-1 text-xs text-muted-foreground" style={{ color: resolvedColor }}>
                {t('labels.createDialog.preview')}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="create-label-value-type">{t('labels.createDialog.valueType')}</Label>
            <Select value={valueType} onValueChange={(value) => setValueType(value as LabelValueType)} disabled={isSubmitting}>
              <SelectTrigger id="create-label-value-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="boolean">{t('labels.createDialog.valueTypeBoolean')}</SelectItem>
                <SelectItem value="string">{t('labels.createDialog.valueTypeString')}</SelectItem>
                <SelectItem value="number">{t('labels.createDialog.valueTypeNumber')}</SelectItem>
                <SelectItem value="date">{t('labels.createDialog.valueTypeDate')}</SelectItem>
                <SelectItem value="link">{t('labels.createDialog.valueTypeLink')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={isSubmitting} onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {isSubmitting ? t('labels.createDialog.creating') : t('labels.createDialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
