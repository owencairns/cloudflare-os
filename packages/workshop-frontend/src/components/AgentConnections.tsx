// The "Connected agents" section of the profile page: what has been connected, what it may do, and
// the button that takes it away again.
//
// There is deliberately **no** "create connection" button here. Agent credentials come into
// existence only when a user approves an OAuth authorization request (see OAuthApprovePage), which
// keeps one story for how an agent gets in and means this list can never show a credential the user
// did not consciously grant. What this section owns is the other half of that: visibility and
// revocation.

import { useCallback, useEffect, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import { Plugs, Trash } from '@phosphor-icons/react'
import {
  AGENT_SCOPE_DESCRIPTIONS, type AgentConnectionInfo,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../AuthContext'
import { logRpcFailure } from '../rpcErrors'

const DANGER_BTN =
  'press inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line px-2.5 text-[13px] font-medium tracking-[-0.2px] text-kumo-danger transition-colors hover:bg-kumo-danger/10 disabled:cursor-not-allowed disabled:opacity-60'

/** "3 days ago" / "just now" — enough precision for "is this still in use?". */
function relativeTime(when: Date): string {
  const seconds = Math.round((Date.now() - when.valueOf()) / 1000)
  if (seconds < 60) return 'just now'
  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'], [60, 'hour'], [24, 'day'], [7, 'week'], [4.348, 'month'], [12, 'year'],
  ]
  let value = seconds
  let unit: Intl.RelativeTimeFormatUnit = 'second'
  for (const [divisor, nextUnit] of units) {
    if (Math.abs(value) < divisor) break
    value = value / divisor
    unit = nextUnit
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
      .format(-Math.round(value), unit)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
      {children}
    </h2>
  )
}

export default function AgentConnections() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [connections, setConnections] = useState<AgentConnectionInfo[] | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setConnections(await authenticatedApi.listAgentConnections())
    } catch (err) {
      logRpcFailure('Failed to list agent connections:', err)
      // An empty list rather than a stuck spinner: the section is informational, and a failure to
      // read it must not look like a permanent loading state.
      setConnections([])
    }
  }, [authenticatedApi])

  useEffect(() => { void refresh() }, [refresh])

  const revoke = async (connection: AgentConnectionInfo) => {
    if (revoking) return
    setRevoking(connection.tokenId)
    try {
      const removed = await authenticatedApi.revokeAgentConnection(connection.tokenId)
      toasts.add({
        title: removed ? `Disconnected ${connection.label}` : 'That connection was already gone',
        variant: removed ? 'success' : 'error',
      })
      await refresh()
    } catch (err) {
      logRpcFailure('Failed to revoke an agent connection:', err)
      toasts.add({ title: 'Failed to disconnect', variant: 'error' })
    } finally {
      setRevoking(null)
    }
  }

  // Nothing connected and nothing loading: stay quiet rather than showing an empty card on every
  // profile page. The section appears the moment there is something to manage.
  if (connections !== null && connections.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Connected agents</SectionLabel>
      <div className="divide-y divide-kumo-line overflow-hidden rounded-xl border border-kumo-line bg-kumo-base">
        {connections === null ? (
          <div className="flex items-center justify-center px-5 py-8">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
          </div>
        ) : (
          connections.map((connection) => (
            <div key={connection.tokenId} className="flex items-center gap-3 px-5 py-4">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-fill">
                <Plugs size={17} className="text-kumo-subtle" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium tracking-[-0.2px] text-kumo-default">
                  {connection.label}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
                  {connection.scopes.length > 0
                    ? connection.scopes
                        .map((scope) => AGENT_SCOPE_DESCRIPTIONS[scope].title)
                        .join(' · ')
                    : 'No permissions granted'}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 tracking-[-0.1px] text-kumo-inactive">
                  Connected {relativeTime(connection.created)}
                  {connection.lastUsed
                    ? ` · last used ${relativeTime(connection.lastUsed)}`
                    : ' · never used'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => revoke(connection)}
                disabled={revoking !== null}
                aria-label={`Disconnect ${connection.label}`}
                className={DANGER_BTN}
              >
                <Trash size={14} />
                {revoking === connection.tokenId ? 'Removing…' : 'Disconnect'}
              </button>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
