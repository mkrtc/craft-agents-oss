import * as React from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { pickWhipMessageKey } from "./whip-logic"
import { WHIP_IDLE_MESSAGE_KEYS } from "./whipMessages"

interface WhipButtonProps {
  isProcessing: boolean
  armed: boolean
  onArm: () => void
  onDisarm: () => void
}

/** Input-row button that arms/disarms the Whip click-to-interrupt easter egg while a session is processing. */
export function WhipButton({ isProcessing, armed, onArm, onDisarm }: WhipButtonProps) {
  const { t } = useTranslation()

  const handleClick = () => {
    if (!isProcessing) {
      toast(t(pickWhipMessageKey(WHIP_IDLE_MESSAGE_KEYS, Math.random())))
      return
    }
    // Toggle: clicking again while armed disarms (an off-switch alongside the overlay's cancel control).
    if (armed) {
      onDisarm()
      return
    }
    onArm()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={t('chat.whipButtonLabel')}
      aria-pressed={armed}
      title={armed ? t('chat.whipButtonArmedTooltip') : t('chat.whipButtonTooltip')}
      className={cn(
        "inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-border/60 bg-[color-mix(in_srgb,var(--background)_97%,var(--foreground)_3%)] text-foreground/80 shadow-minimal transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        armed && "border-amber-500/60 bg-amber-500/10 text-amber-600"
      )}
    >
      <span aria-hidden="true" className="text-[14px] leading-none">🪢</span>
    </button>
  )
}
