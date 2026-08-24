// The consent screen: the one point in the agent-connect flow where a human decides anything.
//
// Everything before this page is machine-to-machine (discovery, registration, an authorization
// request); everything after it is the client redeeming a code. This page exists so that no agent
// ever obtains authority the user did not knowingly hand it, which is why it names the client, lists
// the permissions in plain language, and lets the user drop any of them before approving.
//
// It is a *frontend* route on purpose. `/oauth/authorize` redirects here rather than rendering
// server-side HTML, so the "you must be signed in" requirement is satisfied by the app shell that
// already handles it (see routes/__root.tsx: an unauthenticated visit to any non-public route
// renders the login page, and lands back here on success, because the URL never left the router).
// The decision then travels over the ordinary authenticated RPC channel.

import { useCallback, useEffect, useState } from 'react'
import { useSearch } from '@tanstack/react-router'
import { useKumoToastManager } from '@cloudflare/kumo'
import { ShieldCheck, Warning, Check, Plugs } from '@phosphor-icons/react'
import {
  AGENT_SCOPE_DESCRIPTIONS,
  type AgentAuthorizationRequest,
  type AgentScope,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from './AuthContext'
import { useDocumentTitle } from './useDocumentTitle'
import { useSiteName } from './ServerConfigContext'
import { logRpcFailure } from './rpcErrors'

const PRIMARY_BTN =
  'press inline-flex h-10 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-4 text-[14px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'
const SECONDARY_BTN =
  'press inline-flex h-10 flex-1 cursor-pointer items-center justify-center rounded-lg border border-kumo-line bg-kumo-base px-4 text-[14px] font-medium tracking-[-0.25px] text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-60'

/** The origin of a redirect URI, which is the part of it worth showing a human. */
function redirectOrigin(uri: string): string {
  try {
    return new URL(uri).origin
  } catch {
    return uri
  }
}

export default function OAuthApprovePage() {
  const { authenticatedApi } = useAuthenticatedApi()
  const siteName = useSiteName()
  const toasts = useKumoToastManager()
  useDocumentTitle('Connect an agent')

  // The route validates `request` into a string (possibly empty); an absent one is simply an
  // invalid request, handled by the same branch as an expired one.
  const { request: requestId } = useSearch({ from: '/oauth/approve' })

  const [request, setRequest] = useState<AgentAuthorizationRequest | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<AgentScope[]>([])
  const [submitting, setSubmitting] = useState<'approve' | 'deny' | null>(null)

  useEffect(() => {
    let cancelled = false
    if (!requestId) {
      setLoading(false)
      return
    }
    authenticatedApi
      .getAgentAuthorizationRequest(requestId)
      .then((result) => {
        if (cancelled) return
        setRequest(result)
        // Everything the client asked for and the user may grant starts checked: the default is
        // "approve what was requested", and unchecking is the deliberate act.
        setSelected(result ? [...result.grantableScopes] : [])
        setLoading(false)
      })
      .catch((err) => {
        logRpcFailure('Failed to load the authorization request:', err)
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [authenticatedApi, requestId])

  const decide = useCallback(
    async (approve: boolean) => {
      if (!request || submitting) return
      setSubmitting(approve ? 'approve' : 'deny')
      try {
        const target = await authenticatedApi.decideAgentAuthorization(
          request.requestId,
          approve ? { approve: true, scopes: selected } : { approve: false },
        )
        // A full-page navigation, not a router navigate: the destination belongs to the client
        // (very often a loopback URL on the user's own machine), not to this app.
        window.location.href = target
      } catch (err) {
        logRpcFailure('Failed to record the authorization decision:', err)
        toasts.add({
          title: err instanceof Error ? err.message : 'Could not complete the connection',
          variant: 'error',
        })
        setSubmitting(null)
      }
    },
    [authenticatedApi, request, selected, submitting, toasts],
  )

  if (loading) {
    return (
      <Centered>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-kumo-brand border-t-transparent" />
      </Centered>
    )
  }

  if (!request) {
    return (
      <Centered>
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-kumo-danger/10">
            <Warning size={22} className="text-kumo-danger" />
          </div>
          <h1 className="text-[18px] font-medium tracking-[-0.3px] text-kumo-default">
            This connection request is no longer valid
          </h1>
          <p className="text-[13px] leading-5 tracking-[-0.1px] text-kumo-subtle">
            Authorization requests expire after a few minutes, and each one can be answered only
            once. Start the connection again from the app you were connecting.
          </p>
        </div>
      </Centered>
    )
  }

  const nothingGrantable = request.grantableScopes.length === 0
  const withheld = request.requestedScopes.filter((s) => !request.grantableScopes.includes(s))

  return (
    <Centered>
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base">
        <div className="flex flex-col items-center gap-3 border-b border-kumo-line px-6 py-7 text-center">
          <div className="grid h-11 w-11 place-items-center rounded-full bg-kumo-brand/10">
            <Plugs size={22} className="text-kumo-brand" />
          </div>
          <div>
            <h1 className="text-[18px] font-medium tracking-[-0.3px] text-kumo-default">
              Connect{' '}
              {/* Client-supplied text. React escapes it; it is never rendered as markup. */}
              <span className="font-semibold">{request.clientName}</span>
            </h1>
            <p className="mt-1 text-[13px] leading-5 tracking-[-0.1px] text-kumo-subtle">
              It is asking for access to your {siteName} account.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5 px-6 py-5">
          <p className="px-1 pb-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
            Permissions
          </p>
          {request.grantableScopes.map((scope) => {
            const checked = selected.includes(scope)
            return (
              <label
                key={scope}
                className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-kumo-tint"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(scope)
                        ? current.filter((s) => s !== scope)
                        : [...current, scope],
                    )
                  }
                  className="mt-0.5 h-4 w-4 shrink-0 accent-kumo-brand"
                />
                <span className="min-w-0">
                  <span className="block text-[14px] tracking-[-0.2px] text-kumo-default">
                    {AGENT_SCOPE_DESCRIPTIONS[scope].title}
                  </span>
                  <span className="mt-0.5 block text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
                    {AGENT_SCOPE_DESCRIPTIONS[scope].detail}
                  </span>
                </span>
              </label>
            )
          })}

          {/* Requested but ungrantable — today, `admin` for a non-admin. Shown rather than hidden,
              so the user can see exactly what the client asked for. */}
          {withheld.map((scope) => (
            <div key={scope} className="flex items-start gap-3 px-2 py-2 opacity-55">
              <div className="mt-0.5 h-4 w-4 shrink-0 rounded border border-kumo-line" />
              <span className="min-w-0">
                <span className="block text-[14px] tracking-[-0.2px] text-kumo-default line-through">
                  {AGENT_SCOPE_DESCRIPTIONS[scope].title}
                </span>
                <span className="mt-0.5 block text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
                  Requested, but your account cannot grant it.
                </span>
              </span>
            </div>
          ))}

          {nothingGrantable && (
            <p className="px-2 py-2 text-[13px] leading-5 tracking-[-0.1px] text-kumo-danger">
              None of the requested permissions can be granted by this account.
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-kumo-line bg-kumo-tint/40 px-6 py-5">
          <div className="flex gap-2.5">
            <button
              type="button"
              onClick={() => decide(false)}
              disabled={submitting !== null}
              className={SECONDARY_BTN}
            >
              {submitting === 'deny' ? 'Cancelling…' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={() => decide(true)}
              disabled={submitting !== null || selected.length === 0}
              className={PRIMARY_BTN}
            >
              <Check size={15} weight="bold" />
              {submitting === 'approve' ? 'Connecting…' : 'Allow access'}
            </button>
          </div>
          <p className="flex items-start gap-1.5 text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
            <ShieldCheck size={14} className="mt-px shrink-0" />
            <span>
              You will be sent back to <strong>{redirectOrigin(request.redirectUri)}</strong>. You
              can revoke this connection at any time from your profile.
            </span>
          </p>
        </div>
      </div>
    </Centered>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">{children}</div>
  )
}
