// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// The invariant a flapping backend socket puts under pressure: a dropped-and-restored connection
// must leave the UI working, without a manual reload.
//
// The transport already recovers -- main.tsx reconnects, `useAuth` re-authenticates against the
// fresh session, and `useWorkspaceOpen` re-opens the workspace because `authenticatedApi` is one
// of its dependencies. What that recovery must *not* do is destroy the tree on the way through.
// `ProtectedRoute` gates its children on `isAuthenticated`, so if `authenticatedApi` is ever
// observed as null mid-reconnect, every workspace view below it unmounts: the gadget iframe is
// rebuilt, its bundle re-fetched, its handshake restarted. Under a flap faster than that rebuild,
// the gadget never finishes loading and the pane stays blank until the user reloads -- which is
// precisely the reported symptom, and is invisible to every guard inside GadgetUI because the
// component holding those guards is the thing being destroyed.
//
// These tests pin the continuity property directly, at the seam where it would break.

import { act, useEffect, useRef, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { PublicApi, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { useAuth } from './useAuth'

vi.mock('./errorReporting', () => ({
  setReportedUserId: vi.fn<(reportedUserId: string | undefined) => void>(),
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const person: AiChatAuthorInfo = { type: 'user', id: 'person@example.com', name: 'Person' }

/** One connection's worth of PublicApi. A reconnect produces a new one, as main.tsx does. */
function connection(label: string): RpcStub<PublicApi> {
  const authenticated = {
    label,
    whoami: async () => person,
    amIAdmin: async () => false,
    [Symbol.dispose]: () => {},
  }
  const stub = {
    authenticate: () => authenticated,
    authenticateFromCfAccess: () => authenticated,
  }
  return stub as unknown as RpcStub<PublicApi>
}

// Stands in for everything below ProtectedRoute: the workspace, the editor, the gadget iframe.
// Counts its own mounts, because a remount is the failure -- a re-render is not.
function makeWorkspace() {
  const state = { mounts: 0, unmounts: 0 }
  function Workspace() {
    useEffect(() => {
      state.mounts++
      return () => { state.unmounts++ }
    }, [])
    return <div data-testid="workspace" />
  }
  return { state, Workspace }
}

describe('reconnect continuity', () => {
  const roots: Root[] = []
  const containers: HTMLDivElement[] = []

  afterEach(() => {
    act(() => roots.forEach(root => root.unmount()))
    roots.length = 0
    containers.forEach(container => container.remove())
    containers.length = 0
    localStorage.clear()
    vi.clearAllMocks()
  })

  /**
   * Mirrors ProtectedRoute's gate: children render only while authenticated. Also records every
   * value `authenticatedApi` takes, so a transient null is caught even when React's batching
   * happens to collapse the render it would have caused.
   */
  async function mountApp(initial: RpcStub<PublicApi>, Workspace: () => ReactElement) {
    // The authenticated stub's own type is irrelevant here; only whether it is ever null is.
    const seen: unknown[] = []
    let setConnection!: (next: RpcStub<PublicApi>) => void

    function App() {
      const [publicApi, setPublicApi] = useState(initial)
      setConnection = setPublicApi
      const { authenticatedApi, isAuthenticated } = useAuth(publicApi)
      const lastSeen = useRef<unknown>(undefined)
      if (lastSeen.current !== authenticatedApi) {
        lastSeen.current = authenticatedApi
        seen.push(authenticatedApi)
      }
      if (!isAuthenticated) return <div data-testid="gate" />
      return <Workspace />
    }

    const container = document.createElement('div')
    document.body.append(container)
    containers.push(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => root.render(<App />))
    return { container, seen, reconnect: (next: RpcStub<PublicApi>) => setConnection(next) }
  }

  it('keeps the workspace mounted across a dropped-and-restored connection', async () => {
    localStorage.setItem('authToken', 'stored-token')
    const { state, Workspace } = makeWorkspace()
    const app = await mountApp(connection('first'), Workspace)

    expect(state.mounts).toBe(1)
    expect(app.container.querySelector('[data-testid="workspace"]')).not.toBeNull()

    // The socket dies and main.tsx publishes a replacement session.
    await act(async () => app.reconnect(connection('second')))

    // Re-authenticated against the new session, and the tree below the gate never came down.
    expect(app.container.querySelector('[data-testid="workspace"]')).not.toBeNull()
    expect(state.unmounts).toBe(0)
    expect(state.mounts).toBe(1)
  })

  it('never exposes a null authenticated stub while reconnecting', async () => {
    // The stricter form: not merely "no remount happened this time", but "the state that would
    // cause one is never entered". Batching can hide a transient null today and stop hiding it
    // after an unrelated change, so the null itself is what must not exist.
    localStorage.setItem('authToken', 'stored-token')
    const { Workspace } = makeWorkspace()
    const app = await mountApp(connection('first'), Workspace)

    const beforeReconnect = app.seen.length
    await act(async () => app.reconnect(connection('second')))

    expect(app.seen.slice(beforeReconnect)).not.toContain(null)
  })

  it('survives a burst of reconnects without rebuilding the workspace', async () => {
    // A flap is not one drop. Ten in a row must still leave one continuously-mounted workspace.
    localStorage.setItem('authToken', 'stored-token')
    const { state, Workspace } = makeWorkspace()
    const app = await mountApp(connection('gen-0'), Workspace)

    for (let i = 1; i <= 10; i++) {
      await act(async () => app.reconnect(connection(`gen-${i}`)))
    }

    expect(state.mounts).toBe(1)
    expect(state.unmounts).toBe(0)
    expect(app.container.querySelector('[data-testid="workspace"]')).not.toBeNull()
  })
})
