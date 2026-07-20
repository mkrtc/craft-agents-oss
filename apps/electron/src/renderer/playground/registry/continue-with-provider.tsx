import * as React from 'react'
import type { LlmConnectionWithStatus } from '@config/llm-connections'
import type { PermissionMode } from '@craft-agent/shared/agent/modes'
import { Button } from '@/components/ui/button'
import { AppShellProvider, useAppShellContext } from '@/context/AppShellContext'
import { ModalProvider } from '@/context/ModalContext'
import { FreeFormInput } from '@/components/app-shell/input/FreeFormInput'
import { ContinueWithDialog } from '@/components/app-shell/input/ContinueWithDialog'
import { ensureMockElectronAPI } from '../mock-utils'
import type { ComponentEntry } from './types'

const CONNECTIONS: LlmConnectionWithStatus[] = [
  {
    slug: 'codex-1',
    name: 'Codex 1',
    providerType: 'pi',
    piAuthProvider: 'openai-codex',
    authType: 'oauth',
    models: ['pi/gpt-5.4-codex'],
    defaultModel: 'pi/gpt-5.4-codex',
    isAuthenticated: true,
    createdAt: 1,
  },
  {
    slug: 'codex-2',
    name: 'Codex 2',
    providerType: 'pi',
    piAuthProvider: 'openai-codex',
    authType: 'oauth',
    models: ['pi/gpt-5.4-codex', 'pi/gpt-5.3-codex'],
    defaultModel: 'pi/gpt-5.4-codex',
    isAuthenticated: true,
    createdAt: 2,
  },
  {
    slug: 'claude',
    name: 'Claude',
    providerType: 'anthropic',
    authType: 'api_key',
    models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    defaultModel: 'claude-sonnet-4-6',
    isAuthenticated: true,
    createdAt: 3,
  },
]

function ContinuationInputs() {
  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [model, setModel] = React.useState('pi/gpt-5.4-codex')
  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>('ask')
  const [input, setInput] = React.useState('')
  const [simulateError, setSimulateError] = React.useState(false)
  const [lastResult, setLastResult] = React.useState('No continuation created yet')

  const sharedProps = {
    currentModel: model,
    currentConnection: 'codex-1',
    onModelChange: (next: string) => setModel(next),
    onRequestContinue: () => setDialogOpen(true),
    permissionMode,
    onPermissionModeChange: setPermissionMode,
    inputValue: input,
    onInputChange: setInput,
    sessionId: 'continue-playground-session',
    isEmptySession: false,
    onSubmit: () => {},
    onStop: () => {},
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-auto p-6">
      <div>
        <h2 className="text-lg font-semibold">Continue with another provider</h2>
        <p className="text-sm text-muted-foreground">Open the model selector in either layout, then choose Continue with another provider.</p>
      </div>

      <section className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Desktop model menu</div>
        <div className="rounded-xl border bg-background p-3">
          <FreeFormInput {...sharedProps} placeholder="Started Codex conversation" />
        </div>
      </section>

      <section className="space-y-2">
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Compact model drawer</div>
        <div className="rounded-xl border bg-background p-3">
          <FreeFormInput {...sharedProps} compactMode enableCompactModelPicker placeholder="Started Codex conversation" />
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button variant={simulateError ? 'destructive' : 'outline'} size="sm" onClick={() => setSimulateError(value => !value)}>
          {simulateError ? 'Error simulation on' : 'Simulate backend error'}
        </Button>
        <span className="text-sm text-muted-foreground" data-testid="continuation-result">{lastResult}</span>
      </div>

      <ContinueWithDialog
        open={dialogOpen}
        connections={CONNECTIONS}
        currentConnectionSlug="codex-1"
        onOpenChange={setDialogOpen}
        onContinue={async (connectionSlug, selectedModel) => {
          await new Promise(resolve => setTimeout(resolve, 350))
          if (simulateError) throw new Error('Mock handoff generation failed')
          setLastResult(`Created on ${connectionSlug} with ${selectedModel}`)
        }}
      />
    </div>
  )
}

function ContinueWithProviderDemo() {
  const parent = useAppShellContext()

  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  const value = React.useMemo(() => ({
    ...parent,
    llmConnections: CONNECTIONS,
    workspaceDefaultLlmConnection: 'codex-1',
  }), [parent])

  return (
    <AppShellProvider value={value}>
      <ModalProvider>
        <ContinuationInputs />
      </ModalProvider>
    </AppShellProvider>
  )
}

export const continueWithProviderComponents: ComponentEntry[] = [
  {
    id: 'continue-with-provider',
    name: 'Continue With Provider',
    category: 'Chat Inputs',
    description: 'Desktop and compact provider handoff flow with pending and error states',
    component: ContinueWithProviderDemo,
    layout: 'full',
    props: [],
    variants: [],
    mockData: () => ({}),
  },
]
