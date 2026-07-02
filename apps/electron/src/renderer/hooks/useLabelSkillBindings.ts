import { useCallback, useEffect, useState } from 'react'
import type {
  BindableSkillSummary,
  LabelSkillBindingsGenerateParams,
  LabelSkillBindingsGenerateResult,
  LabelSkillBindingsGetResult,
  LabelSkillBindingsSaveInput,
  LabelSkillBindingsSaveResult,
  LoadedSource,
} from '../../shared/types'
import type { LabelSkillBindingsConfig } from '@craft-agent/shared/label-skill-bindings'

const EMPTY_CONFIG: LabelSkillBindingsConfig = { version: 1, bindings: [] }

export interface UseLabelSkillBindingsResult {
  config: LabelSkillBindingsConfig
  validation: LabelSkillBindingsGetResult | LabelSkillBindingsSaveResult | null
  skills: BindableSkillSummary[]
  sources: LoadedSource[]
  isLoading: boolean
  isSaving: boolean
  isGenerating: boolean
  error: string | null
  generationWarnings: string[]
  refresh: () => Promise<void>
  save: (config: LabelSkillBindingsConfig) => Promise<LabelSkillBindingsSaveResult>
  generate: (params: LabelSkillBindingsGenerateParams) => Promise<LabelSkillBindingsGenerateResult>
}

/**
 * Workspace-scoped hook for the Label → Skill Bindings settings page.
 *
 * The backing RPCs expose metadata-only skill summaries for normal page loads.
 * Full SKILL.md content is read only by the explicit Generate action.
 */
export function useLabelSkillBindings(
  workspaceId: string | null,
  workingDirectory?: string,
): UseLabelSkillBindingsResult {
  const [config, setConfig] = useState<LabelSkillBindingsConfig>(EMPTY_CONFIG)
  const [validation, setValidation] = useState<LabelSkillBindingsGetResult | LabelSkillBindingsSaveResult | null>(null)
  const [skills, setSkills] = useState<BindableSkillSummary[]>([])
  const [sources, setSources] = useState<LoadedSource[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [generationWarnings, setGenerationWarnings] = useState<string[]>([])

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setConfig(EMPTY_CONFIG)
      setValidation(null)
      setSkills([])
      setSources([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const [bindingResult, bindableSkills, workspaceSources] = await Promise.all([
        window.electronAPI.getLabelSkillBindings(workspaceId, workingDirectory),
        window.electronAPI.listBindableSkills(workspaceId, workingDirectory),
        window.electronAPI.getSources(workspaceId),
      ])
      setConfig(bindingResult.config)
      setValidation(bindingResult)
      setSkills(bindableSkills)
      setSources(workspaceSources)
      setError(null)
    } catch (err) {
      console.error('[useLabelSkillBindings] Failed to load bindings:', err)
      setError(err instanceof Error ? err.message : 'Failed to load label-skill bindings')
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId, workingDirectory])

  const save = useCallback(async (nextConfig: LabelSkillBindingsConfig) => {
    if (!workspaceId) throw new Error('Workspace is required')
    setIsSaving(true)
    try {
      const input: LabelSkillBindingsSaveInput = { config: nextConfig, workingDirectory }
      const result = await window.electronAPI.saveLabelSkillBindings(workspaceId, input)
      setConfig(result.config)
      setValidation(result)
      setError(null)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save label-skill bindings'
      setError(message)
      throw err
    } finally {
      setIsSaving(false)
    }
  }, [workspaceId, workingDirectory])

  const generate = useCallback(async (params: LabelSkillBindingsGenerateParams) => {
    if (!workspaceId) throw new Error('Workspace is required')
    setIsGenerating(true)
    setGenerationWarnings([])
    try {
      const result = await window.electronAPI.generateLabelSkillCompactInstruction(workspaceId, {
        ...params,
        workingDirectory: params.workingDirectory ?? workingDirectory,
      })
      setGenerationWarnings(result.warnings)
      setError(null)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate compact instruction'
      setError(message)
      throw err
    } finally {
      setIsGenerating(false)
    }
  }, [workspaceId, workingDirectory])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    if (!workspaceId) return

    const cleanups = [
      window.electronAPI.onLabelSkillBindingsChanged((changedWorkspaceId) => {
        if (changedWorkspaceId === workspaceId) refresh()
      }),
      window.electronAPI.onLabelsChanged((changedWorkspaceId) => {
        if (changedWorkspaceId === workspaceId) refresh()
      }),
      window.electronAPI.onSkillsChanged((changedWorkspaceId) => {
        if (changedWorkspaceId === workspaceId) refresh()
      }),
      window.electronAPI.onSourcesChanged((changedWorkspaceId) => {
        if (changedWorkspaceId === workspaceId) refresh()
      }),
    ]

    return () => {
      for (const cleanup of cleanups) cleanup()
    }
  }, [workspaceId, refresh])

  return {
    config,
    validation,
    skills,
    sources,
    isLoading,
    isSaving,
    isGenerating,
    error,
    generationWarnings,
    refresh,
    save,
    generate,
  }
}
