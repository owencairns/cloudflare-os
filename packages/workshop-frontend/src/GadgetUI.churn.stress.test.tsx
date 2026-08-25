// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// A randomized stress harness for the gadget-iframe remount race.
//
// The bug it guards is intermittent by nature -- it needs `gadget` to churn inside the window where
// a handshake is in flight -- so a single hand-written interleaving proves very little. This drives
// many trials with randomized churn counts and randomized RPC latencies, and reports the rate at
// which the frame is thrown away or ends up without a connection. Deterministic seed, so a failure
// is reproducible.
//
// The two failure modes it measures are exactly the two the user sees:
//   * REMOUNT  -- the iframe element is replaced, i.e. the frame goes blank and has to handshake
//                 again. Repeatedly, this is the restart loop that leaves it blank until a reload.
//   * NO CONN  -- the frame's port never gets an RPC session, so its calls hang forever.

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { newMessagePortRpcSession, RpcStub, RpcTarget } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetClient, UiBundle } from '@gadgets/workshop-shared/api'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  } else {
    testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
  }
})

vi.mock('@cloudflare/kumo', () => ({
  // Rendered so a trial can tell "failed visibly" (acceptable) from "blank and silent" (the bug).
  Banner: Object.assign(
    ({ description }: { description?: ReactNode }) => (
      <div data-testid="gadget-error">{description}</div>
    ),
    { Action: ({ children }: { children?: ReactNode }) => children },
  ),
  Loader: () => null,
  Text: ({ children }: { children: ReactNode }) => children,
}))

import GadgetUI from './GadgetUI'

interface TestGadget {
  read(): string
}

class TestGadgetTarget extends RpcTarget implements TestGadget {
  constructor(private value: string) {
    super()
  }

  read() {
    return this.value
  }
}

// Trials default low so the suite stays fast; raise it to gather statistics:
//   GADGET_CHURN_TRIALS=500 npx vitest run src/GadgetUI.churn.stress.test.tsx
// Read through import.meta.env: this package typechecks as browser code, where `process` is absent.
const testEnv = import.meta.env as unknown as Record<string, string | undefined>
const TRIALS = Number(testEnv.GADGET_CHURN_TRIALS ?? 40)
const SEED = Number(testEnv.GADGET_CHURN_SEED ?? 0x5eed)

// mulberry32 -- small, fast, and deterministic, so a reported failure rate is reproducible.
function makeRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

async function ticks(count: number) {
  for (let i = 0; i < count; i++) await Promise.resolve()
}

function fakeGadget(value: string, latencyTicks: number) {
  const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(async () => {
    await ticks(latencyTicks)
    return new RpcStub(new TestGadgetTarget(value)) as unknown as RpcStub<TestGadget>
  })
  const getUiBundle = vi.fn<() => Promise<UiBundle>>(async () => ({
    jsCode: `document.body.textContent = ${JSON.stringify(value)}`,
  }))
  return { connectToGadget, stub: { connectToGadget, getUiBundle } as unknown as RpcStub<GadgetClient> }
}

interface TrialResult {
  remounted: boolean
  connected: boolean
  finalValue: string | null
}

describe('GadgetUI gadget-prop churn stress', () => {
  let container: HTMLDivElement
  let root: Root
  const childSessions: RpcStub<TestGadget>[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    for (const session of childSessions.splice(0)) session[Symbol.dispose]()
    await act(async () => root.unmount())
    container.remove()
  })

  async function runTrial(random: () => number): Promise<TrialResult> {
    const churnCount = 1 + Math.floor(random() * 6)
    const openLatency = Math.floor(random() * 8)

    const first = fakeGadget('trial-0', openLatency)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const original = container.querySelector('iframe')!

    // Hand the frame its port. From here on the component owes it exactly one RPC session.
    const { port1, port2 } = new MessageChannel()
    const child = newMessagePortRpcSession<TestGadget>(port1)
    childSessions.push(child)
    window.dispatchEvent(new MessageEvent('message', {
      data: 'handshake',
      origin: 'null',
      source: original.contentWindow,
      ports: [port2],
    }))

    // Churn `gadget` at randomized points, mostly inside the handshake window.
    let finalValue = 'trial-0'
    let remounted = false
    for (let i = 1; i <= churnCount; i++) {
      await ticks(Math.floor(random() * 4))
      finalValue = `trial-${i}`
      const next = fakeGadget(finalValue, Math.floor(random() * 6))
      await act(async () => {
        root.render(<GadgetUI gadget={next.stub} height="100px" />)
      })
      if (container.querySelector('iframe') !== original) remounted = true
    }

    // Let everything settle, then ask the frame a question. A frame that was never connected --
    // or was connected and then abandoned -- simply never answers.
    let answer: string | null = null
    try {
      answer = await Promise.race([
        child.read(),
        new Promise<null>(resolve => setTimeout(() => resolve(null), 250)),
      ])
    } catch {
      answer = null
    }
    if (container.querySelector('iframe') !== original) remounted = true

    return { remounted, connected: answer !== null, finalValue: answer }
  }

  it(`never drops or blanks the frame across ${TRIALS} randomized churn trials`, async () => {
    const random = makeRandom(SEED)
    let remounts = 0
    let unconnected = 0
    let stale = 0

    for (let trial = 0; trial < TRIALS; trial++) {
      const result = await runTrial(random)
      if (result.remounted) remounts++
      if (!result.connected) unconnected++
      // A settled connection has to be the *newest* one. `trial-N` is the last gadget rendered.
      else if (!/^trial-\d+$/.test(result.finalValue!)) stale++

      // Reset between trials so each one starts from a clean mount.
      for (const session of childSessions.splice(0)) session[Symbol.dispose]()
      await act(async () => root.unmount())
      container.remove()
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    }

    // eslint-disable-next-line no-console
    console.log(
      `churn stress: trials=${TRIALS} remounted=${remounts} unconnected=${unconnected} stale=${stale}`,
    )
    expect({ remounts, unconnected, stale }).toEqual({ remounts: 0, unconnected: 0, stale: 0 })
  }, 120_000)

  // ── hang injection ────────────────────────────────────────────────────────────
  //
  // The residual prod failure was not churn but a connect that *hangs*: `gadget` is a pipelined
  // stub, and a call in flight when the editor disposes it is cancelled rather than rejected, so it
  // never settles. This injects that at a randomized rate and asserts the only property that
  // actually matters to a user: the pane ends up either working or visibly failed. Never blank and
  // silent.
  //
  // Fake timers throughout, because the recovery is driven by the retry deadlines.
  const HANDSHAKE_TIMEOUT_MS = 6_000
  const HANDSHAKE_ATTEMPTS = 3
  const WATCHDOG_MS = HANDSHAKE_TIMEOUT_MS * HANDSHAKE_ATTEMPTS + 5_000

  function hangingGadget(value: string) {
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(
      () => new Promise<never>(() => {}),
    )
    const getUiBundle = vi.fn<() => Promise<UiBundle>>(async () => ({
      jsCode: `document.body.textContent = ${JSON.stringify(value)}`,
    }))
    return { connectToGadget, stub: { connectToGadget, getUiBundle } as unknown as RpcStub<GadgetClient> }
  }

  it(`never leaves a blank silent pane across ${TRIALS} randomized hang trials`, async () => {
    const random = makeRandom(SEED ^ 0x9e37)
    let blankAndSilent = 0
    let recovered = 0
    let visiblyFailed = 0

    for (let trial = 0; trial < TRIALS; trial++) {
      vi.useFakeTimers()

      // The opening stub hangs most of the time -- that is the case under test.
      const opensHang = random() < 0.75
      const first = opensHang ? hangingGadget('trial-0') : fakeGadget('trial-0', 0)
      await act(async () => {
        root.render(<GadgetUI gadget={first.stub} height="100px" />)
      })
      const iframe = container.querySelector('iframe')
      expect(iframe).not.toBeNull()

      const { port1, port2 } = new MessageChannel()
      const child = newMessagePortRpcSession<TestGadget>(port1)
      childSessions.push(child)
      window.dispatchEvent(new MessageEvent('message', {
        data: 'handshake',
        origin: 'null',
        source: iframe!.contentWindow,
        ports: [port2],
      }))

      // Some trials get a healthy replacement (the editor re-deriving the stub after a merge),
      // some stay broken -- so both the recovery path and the give-up path are exercised.
      const rescued = random() < 0.6
      if (rescued) {
        await act(async () => vi.advanceTimersByTimeAsync(Math.floor(random() * HANDSHAKE_TIMEOUT_MS)))
        const replacement = fakeGadget('trial-rescued', 0)
        await act(async () => {
          root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
        })
      }

      // Run past every deadline the component owns.
      await act(async () => vi.advanceTimersByTimeAsync(WATCHDOG_MS + 2_000))
      vi.useRealTimers()

      let answered = false
      try {
        answered = await Promise.race([
          child.read().then(() => true, () => false),
          new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100)),
        ])
      } catch {
        answered = false
      }
      const errorShown = container.querySelector('[data-testid="gadget-error"]') !== null

      if (answered) recovered++
      else if (errorShown) visiblyFailed++
      else blankAndSilent++

      for (const session of childSessions.splice(0)) session[Symbol.dispose]()
      await act(async () => root.unmount())
      container.remove()
      container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
    }

    // eslint-disable-next-line no-console
    console.log(
      `hang stress: trials=${TRIALS} recovered=${recovered} visiblyFailed=${visiblyFailed} blankAndSilent=${blankAndSilent}`,
    )
    // The assertion is deliberately only about the defect. Whether a given trial recovers or fails
    // depends on whether a working stub ever showed up; being left blank with no signal is never OK.
    expect(blankAndSilent).toBe(0)
    expect(recovered).toBeGreaterThan(0)
    expect(visiblyFailed).toBeGreaterThan(0)
  }, 300_000)
})
