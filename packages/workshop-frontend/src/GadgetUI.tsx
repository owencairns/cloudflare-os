import { useState, useEffect, useRef } from 'react'
import { Text, Loader, Banner } from '@cloudflare/kumo'
import { Sparkle } from '@phosphor-icons/react'
import { RpcStub, RpcTarget, newMessagePortRpcSession } from 'capnweb'
import { GadgetClient, ConsoleLogEvent, isHexColor } from '@gadgets/workshop-shared/api'
import { useOptionalTheme } from './ThemeContext'
import { useServerConfig } from './ServerConfigContext'
import type { ResolvedThemeMode } from './theme'

// We want to inject Cap'n Web into the Gadget. Luckily it has no dependencies, so we can just take
// the whole module and embed it. We can import the module using ?raw to get a string of the
// content.
import CAPNWEB_BUNDLE from 'capnweb?raw'

// btoa() below requires this to stay ASCII; capnweb's build enforces ASCII-only dist bundles
// since 0.11.1.
let CAPNWEB_BUNDLE_ANNOTATED = `//# sourceURL=jsrpc.js\n${CAPNWEB_BUNDLE}`

// Unfortunately, we will have to embed the code as a data: URL, because our iframe is totally
// sandboxed. Even more unfortunately, since it's a module which we need to import from, we can't
// use the data URL as a <script> tag's source. Instead, we have to use it in an import statement.
// And, guess what? That import statement is going to appear in code which is *also* embedded in
// a data: URL, so we have a doubly-nested data: URL. We'll use base64 encoding for the inner
// data: and URL encoding for the outer, as this largely avoids double-escaping.
//
// In any case, we'll prefix the gadget code with this prefix which imports the Cap'n Web library
// (from a massive data URL) and sets up the RPC connection to the parent.
let INJECTED_CODE_PREFIX = encodeURIComponent(String.raw`//# sourceURL=client.js
import { RpcTarget, RpcStub, newMessagePortRpcSession } from "data:text/javascript;charset=utf-8;base64,${btoa(CAPNWEB_BUNDLE_ANNOTATED)}";

let gadget;  // RPC stub to the gadget's server-side Durable Object.
{
  let {port1, port2} = new MessageChannel();
  window.parent.postMessage("handshake", "*", [port2]);
  gadget = newMessagePortRpcSession(port1);
}

// Monkey-patch console to forward logs to the parent frame.
for (let level of ['debug', 'info', 'log', 'warn', 'error']) {
  let original = console[level];
  console[level] = (...args) => {
    original.apply(console, args);
    try {
      let message = args.map(arg => {
        if (typeof arg === 'string') return arg;
        try { return JSON.stringify(arg); }
        catch { return String(arg); }
      });
      window.parent.postMessage({ type: 'console', level, message }, '*');
    } catch {};
  };
}

// Allow user-activated target=_blank links, but block programmatic popups.
const blockedOpen = () => {
  console.error('window.open() is disabled in Gadget UIs. Use a link with target="_blank" instead.');
  return null;
};
window.open = blockedOpen;
globalThis.open = blockedOpen;
try {
  Window.prototype.open = blockedOpen;
} catch {}

// Forward Escape key presses to the parent frame. The sandboxed iframe captures keydown events
// when it has focus, so the parent never sees them. The workshop UI uses Escape to exit fullscreen
// gadget mode, so forward it explicitly.
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    window.parent.postMessage({ type: 'escape' }, '*');
  }
}, true);

window.addEventListener('click', (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }

  const anchor = event.target.closest('a[href][target]');
  if (!anchor || anchor.target.toLowerCase() !== '_blank') {
    return;
  }

  const rel = new Set((anchor.getAttribute('rel') || '').split(/\s+/).filter(Boolean));
  rel.add('noopener');
  anchor.setAttribute('rel', Array.from(rel).join(' '));
}, true);

// Mirror the Workshop's light/dark mode onto this document. The host seeds data-mode into the
// iframe markup so the *first paint* is already correct, then posts {type: "myoplan-theme", mode}
// on load and on every host theme change. Applying it here means a gadget gets host-driven theming
// for free from :root[data-mode="dark"] CSS; gadgets that want to react in JS can still listen
// for the same message themselves.
window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'myoplan-theme') return;
  if (data.mode !== 'light' && data.mode !== 'dark') return;
  document.documentElement.dataset.mode = data.mode;
  document.documentElement.style.colorScheme = data.mode;
  if (typeof data.accentColor === 'string' && data.accentColor) {
    document.documentElement.dataset.accentColor = data.accentColor;
  } else {
    delete document.documentElement.dataset.accentColor;
  }
});

// Capture unhandled exceptions and promise rejections.
window.addEventListener('error', (event) => {
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Uncaught', event.error?.stack || event.message],
  }, '*');
});
window.addEventListener('unhandledrejection', (event) => {
  let reason = event.reason;
  window.parent.postMessage({
    type: 'console',
    level: 'error',
    message: ['Unhandled promise rejection:', reason?.stack || String(reason)],
  }, '*');
});

`);

/** The appearance state the host pushes into gadget iframes. `mode` is the resolved mode. */
export interface GadgetTheme {
  mode: ResolvedThemeMode
  accentColor: string | null
}

/** The message the host posts into a gadget iframe whenever the resolved theme changes. */
export const GADGET_THEME_MESSAGE_TYPE = 'myoplan-theme'

const createSandboxedHtml = (jsCode: string, theme: GadgetTheme): string => {
  // Seeding data-mode into the markup means first paint is already correct -- no flash of the wrong
  // theme while we wait for the postMessage to arrive. Attributes are inert content, so this needs
  // nothing from the CSP (which forbids everything but data: URLs and inline script/style).
  const accentAttribute = theme.accentColor && isHexColor(theme.accentColor)
    ? ` data-accent-color="${theme.accentColor}"`
    : ''
  return `<!DOCTYPE html>
<html data-mode="${theme.mode}"${accentAttribute} style="color-scheme: ${theme.mode}">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src 'none'; script-src data: 'unsafe-inline'; style-src data: 'unsafe-inline'; img-src data:; media-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; connect-src 'none';">
</head>
<body>
    <script type="module" src="data:text/javascript;charset=utf-8,${INJECTED_CODE_PREFIX}${encodeURIComponent(jsCode)}"></script>
</body>
</html>`.trim()
}

interface GadgetUIProps {
  gadget: RpcStub<GadgetClient>
  height: string
  reloadTrigger?: number
  isVisible?: boolean
  chatId?: number
  onConsoleLog?: (log: ConsoleLogEvent) => void
  // Fires when the user presses Escape while the gadget iframe has focus. Sandboxed iframes
  // capture keydown events, so we forward Escape explicitly from inside the iframe.
  onIframeEscape?: () => void
}

// How long to wait for a UI bundle before offering a retry instead of a spinner. Not a latency
// budget: the point at which we conclude the reply is never coming.
const UI_BUNDLE_LOAD_TIMEOUT_MS = 20_000
const RECONNECT_TIMEOUT_MS = 5_000

// The gadget's own script posts its handshake and then blocks on RPC before painting anything, so a
// handshake we never answer is an indefinitely blank pane with no error in it -- the frame is
// waiting on a promise that never settles, so its `try/catch` never runs either. Every path out of
// the handshake is therefore bounded, and ends in either a session or a visible error.
//
// The connect is the part that can hang rather than fail. `gadget` is a *pipelined* stub
// (GadgetEditor hands over `overseer.stub.getGadget(id)` without awaiting it), and when the editor
// re-derives it -- which is exactly what a code:merge does -- that effect's cleanup disposes the old
// stub. An in-flight pipelined call on a disposed stub is cancelled, and a cancelled call is not a
// rejected one: it simply never settles. So we retry instead of awaiting forever, and each attempt
// re-reads `gadgetRef`, which by then holds the replacement.
const HANDSHAKE_CONNECT_TIMEOUT_MS = 6_000
const HANDSHAKE_CONNECT_ATTEMPTS = 3
// How long to wait for a `gadget` prop when a handshake arrives before one is available.
const HANDSHAKE_GADGET_WAIT_MS = 250
// Last line of defence, covering causes we have not diagnosed (a handshake that never reaches the
// listener, a frame whose script dies before posting one). Generous enough that it can only fire
// when something is genuinely wrong: the injected prefix posts the handshake before any gadget code
// runs, so a healthy frame handshakes within milliseconds of load.
const HANDSHAKE_WATCHDOG_MS = HANDSHAKE_CONNECT_TIMEOUT_MS * HANDSHAKE_CONNECT_ATTEMPTS + 5_000

// Recovery ladder for a gadget stub that breaks *after* the frame is connected -- which is what a
// flapping backend socket does to every capability the page holds. Backs off so a sustained outage
// does not become a reconnect storm, and ends in a visible error rather than retrying forever.
const STUB_RECOVERY_ATTEMPTS = 4
const STUB_RECOVERY_BASE_MS = 500
// How long a connection must survive before it counts as proof the backend is healthy again. A
// connection that establishes and then immediately dies is the *signature* of a flap, not a
// recovery from one, so it must not refill the budget -- otherwise the ladder resets every cycle
// and retries forever, which is the reconnect storm it exists to prevent.
const STUB_RECOVERY_STABLE_MS = 10_000

export default function GadgetUI(props: GadgetUIProps) {
  return <GadgetUISession key={props.chatId} {...props} />
}

function GadgetUISession({ gadget, height, reloadTrigger, isVisible = true, chatId, onConsoleLog, onIframeEscape }: GadgetUIProps) {
  const [sandboxedHtml, setSandboxedHtml] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [isInvalidated, setIsInvalidated] = useState(false)
  const [iframeGeneration, setIframeGeneration] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const prevReloadTriggerRef = useRef(reloadTrigger)
  // Identifies the newest bundle load, so an older one can't write state after being superseded.
  const loadGenerationRef = useRef(0)
  // Bumped by the retry button to ask for a fresh load.
  const [retryNonce, setRetryNonce] = useState(0)
  const connectionGenerationRef = useRef(0)
  const handshakePendingRef = useRef<number | null>(null)
  // Identifies the newest (gadget, chatId) pair the component has been asked to talk to. The
  // handshake handler samples it before its `connectToGadget` and compares afterwards: an
  // unchanged token means the stub it just opened is still the right one, a changed token means
  // the props moved on mid-handshake and the frame needs a redirect once it is connected. This is
  // the whole damping mechanism -- it is read, never waited on, so churn can never restart the
  // handshake.
  const targetGenerationRef = useRef(0)
  // Whether the current iframe has ever been heard from. Distinguishes "we answered badly" from
  // "it never spoke to us", which are different bugs with the same blank symptom.
  const handshakeSeenRef = useRef(false)
  // Recovery ladder state for a stub that breaks after the frame is connected. Reset by any
  // connection that actually settles, so a healthy session always starts from a full budget.
  const recoveryAttemptsRef = useRef(0)
  const recoveryTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // When the current connection was established, so a break can tell a blip from a flap.
  const connectionSettledAtRef = useRef(0)
  const gadgetRef = useRef(gadget)
  gadgetRef.current = gadget
  const chatIdRef = useRef(chatId)
  chatIdRef.current = chatId
  // TODO: Remove `any` when Cap'n Web fixes cyclic type issues (RpcStub<any> triggers deep instantiation)
  const gadgetStubRef = useRef<any>(null)
  const pendingGadgetStubRef = useRef<{
    promise: Promise<any>
    resolve: (stub: any) => void
    reject: (reason: unknown) => void
  } | null>(null)
  const rpcSessionRef = useRef<any>(null)
  // Push the Workshop's resolved light/dark mode (and deployment accent) into the gadget iframe, the
  // same appearance state SandboxedGatekeeperApp hands to gatekeeper apps over RPC. Gadgets have no
  // RPC channel back to the host frame, so the transport here is a plain postMessage.
  const themeContext = useOptionalTheme()
  // Without a ThemeProvider, fall back to whatever mode is already applied to <html> -- the provider
  // is the only thing that sets it, so reading it back is the same answer without the dependency.
  const resolvedThemeMode: ResolvedThemeMode = themeContext?.resolvedThemeMode
    ?? (document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light')
  const configuredAccentColor = useServerConfig()?.accentColor
  const accentColor = configuredAccentColor && isHexColor(configuredAccentColor)
    ? configuredAccentColor
    : null
  const themeRef = useRef<GadgetTheme>({ mode: resolvedThemeMode, accentColor })
  themeRef.current = { mode: resolvedThemeMode, accentColor }

  const postTheme = () => {
    iframeRef.current?.contentWindow?.postMessage(
      { type: GADGET_THEME_MESSAGE_TYPE, ...themeRef.current },
      '*',
    )
  }

  // Re-push on every host theme change. The iframe is *not* rebuilt: the markup seed only has to be
  // right for first paint, and rebuilding srcDoc would remount (and reset) the running gadget.
  useEffect(() => {
    postTheme()
  }, [resolvedThemeMode, accentColor])

  // Keep latest callbacks in refs so the message-handler effect never tears down the RPC session.
  const onIframeEscapeRef = useRef(onIframeEscape)
  const onConsoleLogRef = useRef(onConsoleLog)
  onIframeEscapeRef.current = onIframeEscape
  onConsoleLogRef.current = onConsoleLog

  const suspendGadgetCalls = () => {
    if (!pendingGadgetStubRef.current) {
      let resolve!: (stub: any) => void
      let reject!: (reason: unknown) => void
      const promise = new Promise<any>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
      })
      void promise.catch(() => {})
      pendingGadgetStubRef.current = { promise, resolve, reject }
    }
    return pendingGadgetStubRef.current
  }

  const installGadgetStub = (stub: any) => {
    gadgetStubRef.current = stub
    stub.onRpcBroken?.(() => {
      if (gadgetStubRef.current === stub) handleStubBroken()
    })
  }

  // A gadget stub that breaks after the frame is connected used to raise the call-suspension gate
  // and stop there, waiting for a `gadget` prop change to lower it again. That is a bad bet: when
  // the backend socket flaps, every capability the page holds breaks at once, and the prop change
  // that would resolve the gate may never come. The frame is then blank *with a live session* --
  // its calls parked on a promise nobody will ever settle -- which is invisible to the handshake
  // watchdog and produces exactly the reported symptom: full bundle, no error, nothing painted.
  //
  // So recover on our own: reconnect against whatever `gadget` is current, backing off, and give
  // up visibly rather than silently.
  const handleStubBroken = () => {
    suspendGadgetCalls()
    if (recoveryTimerRef.current !== undefined) return  // a recovery is already scheduled
    // Only a connection that lasted counts as recovery; see STUB_RECOVERY_STABLE_MS.
    if (Date.now() - connectionSettledAtRef.current >= STUB_RECOVERY_STABLE_MS) {
      recoveryAttemptsRef.current = 0
    }
    if (recoveryAttemptsRef.current >= STUB_RECOVERY_ATTEMPTS) {
      console.error('Gadget connection kept breaking; giving up after',
        STUB_RECOVERY_ATTEMPTS, 'attempts.')
      setError('Lost the connection to this gadget.')
      return
    }
    const delay = STUB_RECOVERY_BASE_MS * 2 ** recoveryAttemptsRef.current++
    recoveryTimerRef.current = setTimeout(() => {
      recoveryTimerRef.current = undefined
      redirectToCurrentGadget()
    }, delay)
  }

  const resetConnection = (reason: unknown) => {
    ++connectionGenerationRef.current
    handshakePendingRef.current = null
    pendingGadgetStubRef.current?.reject(reason)
    pendingGadgetStubRef.current = null
    gadgetStubRef.current?.[Symbol.dispose]?.()
    gadgetStubRef.current = null
    rpcSessionRef.current?.[Symbol.dispose]?.()
    rpcSessionRef.current = null
  }

  const reloadIframe = (reason: unknown) => {
    resetConnection(reason)
    setIframeGeneration(generation => generation + 1)
  }

  // Open a gadget connection on behalf of a frame that is blocked on its handshake. Bounded by
  // construction: at most HANDSHAKE_CONNECT_ATTEMPTS attempts, each with its own deadline, so the
  // caller either gets a stub, learns the frame is gone (`null`), or gets an error to show. It
  // never waits indefinitely on one attempt, which is the whole point -- see the note on
  // HANDSHAKE_CONNECT_TIMEOUT_MS for why an attempt can hang instead of failing.
  //
  // `gadgetRef`/`chatIdRef` are re-read per attempt rather than captured, so a retry naturally
  // targets whatever replaced the stub that hung.
  const connectForHandshake = async (isFrameCurrent: () => boolean): Promise<any> => {
    let lastError: unknown = new Error('Could not open a gadget connection for the UI frame.')

    for (let attempt = 0; attempt < HANDSHAKE_CONNECT_ATTEMPTS; attempt++) {
      if (!isFrameCurrent()) return null

      const target = gadgetRef.current
      if (!target) {
        // A handshake can beat the stub it needs. Waiting costs an attempt but nothing else, and
        // the frame is held rather than abandoned.
        lastError = new Error('No gadget client was available for the UI frame.')
        await new Promise(resolve => setTimeout(resolve, HANDSHAKE_GADGET_WAIT_MS))
        continue
      }

      // A timed-out attempt is abandoned, not cancelled -- there is no way to cancel it. If it ever
      // does land, dispose it, so giving up on it cannot leak the capability. The flag has to be
      // set by whoever gives up (the timeout, or a rejection) rather than cleared by the winner:
      // this handler is registered before `Promise.race`'s own, so it always runs first, and a
      // "have we taken it yet" test would read false on the very attempt we are about to use.
      let abandoned = false
      const attemptPromise = Promise.resolve().then(() => target.connectToGadget(chatIdRef.current))
      void attemptPromise.then(stub => {
        if (abandoned) stub?.[Symbol.dispose]?.()
      }, () => {})

      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          attemptPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              abandoned = true
              reject(new Error('Timed out opening the gadget connection.'))
            }, HANDSHAKE_CONNECT_TIMEOUT_MS)
          }),
        ])
      } catch (caught) {
        abandoned = true
        lastError = caught
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    }

    throw lastError
  }

  // Point the live RPC session at whatever `gadget`/`chatId` are current, without touching the
  // iframe. Top-level calls are suspended on a promise until the replacement stub lands, so nothing
  // reaches the outgoing stub in the meantime and nothing is dropped.
  const redirectToCurrentGadget = () => {
    const generation = ++connectionGenerationRef.current
    const isCurrent = () => generation === connectionGenerationRef.current
    const pendingStub = suspendGadgetCalls()
    const targetGadget = gadgetRef.current
    const targetChatId = chatIdRef.current
    const replacementPromise = Promise.resolve().then(() => targetGadget.connectToGadget(targetChatId))
    void replacementPromise.then(stub => {
      if (!isCurrent()) stub[Symbol.dispose]?.()
    }, () => {})

    const reconnect = async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const replacementStub = await Promise.race([
          replacementPromise,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Timed out reconnecting gadget UI.')), RECONNECT_TIMEOUT_MS)
          }),
        ])
        if (!isCurrent()) return
        const oldStub = gadgetStubRef.current
        installGadgetStub(replacementStub)
        pendingStub.resolve(replacementStub)
        if (pendingGadgetStubRef.current === pendingStub) pendingGadgetStubRef.current = null
        oldStub?.[Symbol.dispose]?.()
        // Start the clock rather than refilling the budget here: only a connection that *survives*
        // proves the backend is healthy, and that is judged when it next breaks.
        connectionSettledAtRef.current = Date.now()
      } catch (caught) {
        if (isCurrent()) reloadIframe(caught)
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
    }
    void reconnect()
  }

  // React to `gadget`/`chatId` churn. There are exactly three states to be in, and none of them
  // throws the iframe away:
  //
  //  1. A session is live -> redirect it at the new stub. The frame keeps painting throughout.
  //  2. A handshake is in flight -> do NOT restart it. Raise the suspension gate now (so no call
  //     can reach the about-to-be-installed stale stub) and record the churn by bumping the target
  //     generation; the handshake handler sees the mismatch when its `connectToGadget` settles,
  //     connects the frame anyway, and *then* redirects. Deferred reconnect, not a restart.
  //  3. Nothing has handshaked yet -> nothing to do. The handler reads `gadgetRef`/`chatIdRef` at
  //     handshake time, so it will pick up the newest props by itself.
  //
  // This is what fixes the intermittent blank iframe on a fresh navigation to /workspace/<id>. The
  // old code took state 2 as "reload the iframe", which re-entered the same window: the replacement
  // iframe posted a fresh handshake, and any further churn before it settled reloaded again. The
  // frame stayed blank for as long as the churn lasted and nothing damped the loop -- and a fresh
  // navigation is exactly when the stub is still settling, while a reload has a stable stub before
  // the iframe ever mounts. The staleness that reload guarded against is real (the handler already
  // called `connectToGadget` on the *previous* gadget), which is why the answer is to redirect the
  // completed handshake rather than to drop the guard.
  //
  // Termination: churn only ever writes a ref here; nothing in this effect can cause an iframe
  // remount, so no amount of churn can produce another handshake. Each handshake therefore ends in
  // at most one redirect, and each redirect is itself superseded (not restarted) by generation.
  useEffect(() => {
    targetGenerationRef.current++
    if (!rpcSessionRef.current) {
      if (handshakePendingRef.current !== null) suspendGadgetCalls()
      return
    }
    redirectToCurrentGadget()
  }, [gadget, chatId])

  // Watchdog over the whole handshake, per mounted iframe.
  //
  // Everything above bounds the paths it knows about. This bounds the ones it does not: a handshake
  // that never reaches the listener, a frame whose script dies before posting one, a handler that
  // throws somewhere unforeseen. The product defect being fixed is not any single one of those --
  // it is that a gadget pane can sit blank and silent indefinitely, telling the user nothing. A
  // frame that is not connected by the deadline gets an error with a retry instead.
  useEffect(() => {
    if (!sandboxedHtml || !isVisible) return
    handshakeSeenRef.current = false
    const watchdog = setTimeout(() => {
      // A session is not enough: calls still parked on the suspension gate are just as blank to
      // the user as a frame that never connected, and that is the state a flapping backend leaves
      // behind. Treat "connected but suspended this long" as the failure it looks like.
      if (rpcSessionRef.current && !pendingGadgetStubRef.current) return
      const detail = !handshakeSeenRef.current
        ? 'it never sent a handshake'
        : rpcSessionRef.current
          ? 'its calls are still suspended waiting for a working connection'
          : 'its connection never completed'
      console.error(`Gadget UI frame is still unconnected after ${HANDSHAKE_WATCHDOG_MS}ms: ${detail}.`)
      setError('This view never finished connecting.')
    }, HANDSHAKE_WATCHDOG_MS)
    return () => clearTimeout(watchdog)
  }, [sandboxedHtml, isVisible, iframeGeneration, reloadTrigger])

  // Effect to handle reloadTrigger changes (code changes)
  useEffect(() => {
    // Only react if reloadTrigger has actually changed from the previous value
    if (reloadTrigger !== undefined && reloadTrigger !== prevReloadTriggerRef.current && reloadTrigger > 0) {
      // Mark as invalidated but don't reload unless visible
      setIsInvalidated(true)
      if (!isVisible) {
        // If not visible, just clear the current state
        setSandboxedHtml(null)
        setHasLoaded(false)
        setError(null)
      }
      // Update the ref to the current value
      prevReloadTriggerRef.current = reloadTrigger
    }
  }, [reloadTrigger, isVisible])

  // Effect to load UI bundle when component becomes visible for the first time or when invalidated
  useEffect(() => {
    // Only load if:
    // 1. Component is visible AND
    // 2. Either never loaded before OR invalidated due to code changes
    if (!isVisible || (hasLoaded && !isInvalidated)) {
      return
    }

    // Superseded loads are ignored by generation rather than by a per-run `cancelled` flag: a run
    // cancelled mid-call would skip its own `setLoading(false)`, leaving the spinner up with
    // nothing to clear it. Comparing generations means the newest run always owns the flag.
    const generation = ++loadGenerationRef.current
    const isCurrent = () => loadGenerationRef.current === generation

    // A dropped RPC never settles -- e.g. the stub was disposed under us by a reconnect -- and there
    // is nothing to catch. Rather than spin indefinitely, stop owning the load and offer a retry: the
    // call is idempotent, and a button is a far better answer than a spinner that never resolves.
    const giveUp = setTimeout(() => {
      if (!isCurrent()) return
      loadGenerationRef.current++      // so a late reply can no longer write state
      setLoading(false)
      setError('Timed out loading this view.')
    }, UI_BUNDLE_LOAD_TIMEOUT_MS)

    const loadUiBundle = async () => {
      try {
        setLoading(true)
        setError(null)

        const bundle = await gadget.getUiBundle(chatId)
        if (!isCurrent()) return
        if (bundle) {
          const html = createSandboxedHtml(bundle.jsCode, themeRef.current)
          setSandboxedHtml(html)
        } else {
          setSandboxedHtml(null)
        }
        setHasLoaded(true)
        setIsInvalidated(false)
      } catch (err) {
        if (!isCurrent()) return
        console.error('Failed to load UI bundle:', err)
        setError('Failed to load UI bundle')
      } finally {
        if (isCurrent()) setLoading(false)
        clearTimeout(giveUp)
      }
    }

    loadUiBundle()
    return () => {
      clearTimeout(giveUp)
      // Dependencies can change without starting a replacement load (most importantly when the
      // view becomes hidden). Revoke this run explicitly so its late reply cannot populate state
      // for a different gadget, chat, or visibility lifecycle.
      if (isCurrent()) loadGenerationRef.current++
    }
  // LSP reports an error here, but tsc does not.
  // The LSP error is due to bugs that need to be fixed in Cap'n Web.
  }, [gadget, isVisible, hasLoaded, isInvalidated, chatId, retryNonce])

  // Effect to handle iframe RPC handshake
  useEffect(() => {
    let cancelled = false

    const handleMessage = async (event: MessageEvent) => {
      // Only handle messages from our iframe. As an extra level of paranoia, also make sure it's
      // from the null origin, just in case somehow the frame managed to browse away (though that
      // should be blocked). Yes, the null origin is identified by the string value "null", not the
      // JS `null`.
      if (event.origin !== "null") return
      const isFromOurFrame = () => event.source === iframeRef.current?.contentWindow
      if (!isFromOurFrame()) {
        // A handshake carries the frame's only port, so dropping one strands that frame for good.
        // Before dropping, allow for the ref simply not being attached yet: re-check on the next
        // task, by which point React has certainly committed. A message from a genuinely foreign
        // or superseded frame still fails the re-check and is still ignored.
        if (iframeRef.current !== null || event.data !== 'handshake') return
        await new Promise(resolve => setTimeout(resolve, 0))
        if (cancelled || !isFromOurFrame()) return
      }

      if (event.data === 'handshake' && event.ports && event.ports[0]) {
        const port = event.ports[0]
        // The handshake is the earliest proof the gadget's script is running and listening, so it is
        // the earliest safe moment to push the theme. (`load` also pushes, as a backstop.)
        postTheme()
        let gadgetStub: any = null
        resetConnection(new Error('Gadget iframe reloaded.'))
        const generation = connectionGenerationRef.current
        handshakePendingRef.current = generation
        handshakeSeenRef.current = true
        // Frame identity, deliberately kept separate from connection-generation staleness. They are
        // different questions and they want opposite answers: a frame that is gone owes us nothing,
        // while a frame that is still on screen is *waiting*, and staleness is a reason to redirect
        // it -- never a reason to leave it hanging.
        const isFrameCurrent = () => !cancelled &&
          event.source === iframeRef.current?.contentWindow
        // Sampled *before* the call so a `gadget`/`chatId` change that lands while it is in flight
        // is detectable afterwards. This effect has no deps, so the refs -- not the closure -- are
        // the only honest reading of the current props.
        const targetGeneration = targetGenerationRef.current
        try {
          // Open the RPC connection to the gadget's server side, bounded and retried.
          gadgetStub = await connectForHandshake(isFrameCurrent)
          if (gadgetStub === null || !isFrameCurrent()) {
            // The frame went away while we were connecting. Nothing is waiting on this port.
            gadgetStub?.[Symbol.dispose]?.()
            port.close()
            return
          }
          if (generation !== connectionGenerationRef.current && rpcSessionRef.current !== null) {
            // Somebody else already connected this frame. Stand down rather than clobber the live
            // session -- "exactly one session per frame" is the invariant that keeps it painting.
            gadgetStub[Symbol.dispose]?.()
            port.close()
            return
          }
          // The props moved on while we were connecting, so this stub is already stale. Connect the
          // frame with it anyway -- a frame that never gets a session is blank forever -- but raise
          // the suspension gate first, so the forwarding target below queues every call onto the
          // replacement instead of routing it to the stale stub. The redirect at the end of this
          // block resolves that gate. The frame gets exactly one session, and exactly one settled
          // connection behind it.
          const isStale = targetGeneration !== targetGenerationRef.current ||
            generation !== connectionGenerationRef.current
          if (isStale) suspendGadgetCalls()
          connectionSettledAtRef.current = Date.now()
          installGadgetStub(gadgetStub)
          // Redirectable target: swapping gadgetStubRef reconnects top-level calls without reloading.
          const forwardingTarget = new Proxy(new RpcTarget() as any, {
            get: (target, property, receiver) => {
              if (typeof property === 'symbol' || property in target) {
                return Reflect.get(target, property, receiver)
              }
              const pending = pendingGadgetStubRef.current
              return pending
                ? (...args: any[]) => pending.promise.then(stub => stub[property](...args))
                : gadgetStubRef.current[property]
            },
          })
          rpcSessionRef.current = newMessagePortRpcSession(port, forwardingTarget)
          if (isStale) {
            // Deferred reconnect: the frame is live, now point it at the current gadget. Clear the
            // pending marker first so `resetConnection` inside the redirect path cannot mistake
            // this finished handshake for one still in flight.
            handshakePendingRef.current = null
            redirectToCurrentGadget()
          }
        } catch (caught) {
          gadgetStub?.[Symbol.dispose]?.()
          port.close()
          if (!isFrameCurrent()) return
          // The frame is on screen and will never paint by itself, so this has to be said out loud.
          // Closing the port does not tell it anything: the peer of a closed MessagePort is not
          // notified, and it has no session on that port to break in the first place.
          console.error('Failed to establish RPC connection:', caught)
          setError('Failed to connect gadget to server')
        } finally {
          if (handshakePendingRef.current === generation) handshakePendingRef.current = null
        }
      } else if (event.data?.type === 'console' && onConsoleLogRef.current) {
        onConsoleLogRef.current({
          timestamp: new Date(),
          level: event.data.level,
          message: event.data.message,
        })
      } else if (event.data?.type === 'escape') {
        onIframeEscapeRef.current?.()
      }
    }

    window.addEventListener('message', handleMessage)
    return () => {
      cancelled = true
      window.removeEventListener('message', handleMessage)
      if (recoveryTimerRef.current !== undefined) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = undefined
      }
      resetConnection(new Error('Gadget RPC session was closed.'))
    }
  }, [])

  if (!isVisible && !hasLoaded) {
    // Don't render anything if not visible and never loaded
    return (
      <div
        className="flex items-center justify-center text-kumo-subtle"
        style={{ height }}
      >
        <Text variant="secondary">
          Switch to this tab to load the Gadget UI
        </Text>
      </div>
    )
  }

  if (loading) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <Loader size="lg" />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        height,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: '20px'
      }}>
        <Banner
          variant="error"
          title="Error"
          description={error}
          action={
            <Banner.Action
              onClick={() => {
                setError(null)
                setHasLoaded(false)
                setIsInvalidated(false)
                setRetryNonce(n => n + 1)
              }}
            >
              Try again
            </Banner.Action>
          }
        />
      </div>
    )
  }

  if (!sandboxedHtml) {
    return (
      <div
        className="relative overflow-hidden bg-kumo-base"
        style={{
          height,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <div
          className="themed-accent-glow absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-full pointer-events-none"
          style={{
            filter: 'blur(18px)',
          }}
        />

        <div className="relative flex max-w-sm flex-col items-center gap-3 px-6 text-center">
          <div className="themed-user-bubble-shadow flex h-12 w-12 items-center justify-center rounded-xl border border-kumo-line bg-kumo-elevated text-kumo-subtle">
            <Sparkle size={22} weight="regular" />
          </div>
          <div className="space-y-1">
            <h2 className="text-[20px] leading-7 font-normal tracking-[-0.45px] text-kumo-default">
              No gadget UI yet
            </h2>
            <p className="text-[15px] leading-5 font-normal tracking-[-0.3px] text-kumo-subtle">
              When the gadget builds one, it will appear here.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ height, width: '100%' }}>
      <iframe
        key={`${reloadTrigger}:${iframeGeneration}`}
        ref={iframeRef}
        srcDoc={sandboxedHtml}
        onLoad={postTheme}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          border: 'none'
        }}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        title="Gadget UI"
      />
    </div>
  )
}
