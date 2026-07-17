// Dedicated Lane A entry for the CRFT-STREAM-V1 renderer performance harness.
//
// Why a separate entry (not the shared playground):
//   1. It imports ONLY the harness — not the app component registry — so it does
//      NOT pull `SessionFilesSection` (whose module-top-level
//      `window.electronAPI.getRuntimeEnvironment()` read crashes the production
//      `vite preview` boot before the mock installs). This makes Lane A bootable
//      in a plain browser served by `bunx vite preview`.
//   2. It renders WITHOUT React.StrictMode, so render counts are authoritative
//      production single-invocations (the plan forbids mixing StrictMode's
//      doubled dev renders into production metrics).
//
// IMPORTANT: keep `mock-utils` as the FIRST local import — it installs the mock
// `window.electronAPI` as a top-level side effect before any module reads it.
import './playground/mock-utils'

import React from 'react'
import ReactDOM from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { setupI18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { ThemeProvider } from './context/ThemeContext'
import { EscapeInterruptProvider } from './context/EscapeInterruptContext'
import { PlaygroundAppShellProvider } from './playground/PlaygroundAppShellProvider'
import { ChatStreamingPerfHarness } from './playground/perf/ChatStreamingPerfHarness'
import './index.css'

// Initialize i18n before any React rendering.
setupI18n([initReactI18next])

ReactDOM.createRoot(document.getElementById('root')!).render(
  <JotaiProvider>
    <ThemeProvider>
      <EscapeInterruptProvider>
        <PlaygroundAppShellProvider>
          <ChatStreamingPerfHarness />
        </PlaygroundAppShellProvider>
      </EscapeInterruptProvider>
    </ThemeProvider>
  </JotaiProvider>,
)
