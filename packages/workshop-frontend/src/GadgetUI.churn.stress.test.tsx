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
  Banner: () => null,
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
})
