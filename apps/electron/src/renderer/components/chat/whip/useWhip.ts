import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { INITIAL_WHIP_STATE, createWhipGuard, whipReducer } from './whip-logic'

export interface UseWhipParams {
  sessionId: string | undefined
  isProcessing: boolean
}

export interface UseWhipResult {
  armed: boolean
  arm: () => void
  disarm: () => void
  /** Consumes the one-shot guard; true means this call should fire the interrupt. */
  consume: () => boolean
}

/**
 * Manages armed/disarmed state for the Whip click-to-interrupt easter egg.
 * Once armed it stays armed — so the user can keep whipping — until they explicitly
 * disarm (cancel control / whip button), processing ends, or the session changes.
 * There is no arm timeout: armed only matters while a turn is processing, and that
 * end already disarms it.
 */
export function useWhip({ sessionId, isProcessing }: UseWhipParams): UseWhipResult {
  const [state, dispatch] = useReducer(whipReducer, INITIAL_WHIP_STATE)
  const guardRef = useRef(createWhipGuard())

  const disarm = useCallback(() => {
    dispatch({ type: 'disarm' })
  }, [])

  const arm = useCallback(() => {
    guardRef.current.reset()
    dispatch({ type: 'arm' })
  }, [])

  // Auto-disarm the instant processing stops.
  useEffect(() => {
    if (!isProcessing) {
      dispatch({ type: 'processing-ended' })
    }
  }, [isProcessing])

  // Auto-disarm on session change.
  const prevSessionIdRef = useRef(sessionId)
  useEffect(() => {
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId
      dispatch({ type: 'session-changed' })
    }
  }, [sessionId])

  const consume = useCallback(() => guardRef.current.attempt(), [])

  return useMemo(() => ({ armed: state.armed, arm, disarm, consume }), [state.armed, arm, disarm, consume])
}
