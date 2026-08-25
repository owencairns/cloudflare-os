// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

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
  // Rendered (rather than stubbed to null) so tests can assert the frame's failure is *visible*.
  // A blank pane with no signal is the defect; "an error was set" is the fix.
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
  child(): TestChild
  subscribe(callback: RpcStub<TestSubscriber>): TestSubscription
}

interface TestChild {
  read(): string
}

interface TestSubscriber {
  update(value: string): void
}

interface TestSubscription {}

class TestChildTarget extends RpcTarget implements TestChild {
  constructor(private value: string) {
    super()
  }

  read() {
    return this.value
  }
}

class TestSubscriptionTarget extends RpcTarget implements TestSubscription {
  constructor(private unsubscribe: () => void) {
    super()
  }

  [Symbol.dispose]() {
    this.unsubscribe()
  }
}

class TestGadgetTarget extends RpcTarget implements TestGadget {
  private subscribers = new Set<RpcStub<TestSubscriber>>()

  constructor(private value: string, private onDispose?: () => void) {
    super()
  }

  read() {
    return this.value
  }

  child() {
    return new TestChildTarget(this.value)
  }

  async subscribe(callback: RpcStub<TestSubscriber>) {
    const subscriber = callback.dup()
    this.subscribers.add(subscriber)
    const unsubscribe = () => {
      if (this.subscribers.delete(subscriber)) subscriber[Symbol.dispose]()
    }
    subscriber.onRpcBroken(unsubscribe)
    try {
      await subscriber.update(this.value)
      return new TestSubscriptionTarget(unsubscribe)
    } catch (error) {
      unsubscribe()
      throw error
    }
  }

  [Symbol.dispose]() {
    for (const subscriber of this.subscribers) subscriber[Symbol.dispose]()
    this.subscribers.clear()
    this.onDispose?.()
  }
}

class TestCallbacks extends RpcTarget implements TestSubscriber {
  closed = false

  constructor(private values: string[], private reconnect: () => void) {
    super()
  }

  update(value: string) {
    this.values.push(value)
  }

  [Symbol.dispose]() {
    if (!this.closed) this.reconnect()
  }
}

function fakeGadget(
  value: string,
  bundleCode: string,
  connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(
    async () => new RpcStub(new TestGadgetTarget(value)) as unknown as RpcStub<TestGadget>,
  ),
) {
  const getUiBundle = vi.fn<() => Promise<UiBundle>>(async () => ({ jsCode: bundleCode }))
  return {
    connectToGadget,
    getUiBundle,
    stub: { connectToGadget, getUiBundle } as unknown as RpcStub<GadgetClient>,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

// A gadget connection that can actually *break* the way a real one does. A plain local RpcStub
// never fires `onRpcBroken`, so a real capnweb session over a MessageChannel is the only faithful
// way to model a backend socket dropping under an already-connected frame.
function breakableConnection(value: string) {
  const { port1, port2 } = new MessageChannel()
  const host = newMessagePortRpcSession(port2, new TestGadgetTarget(value))
  const client = newMessagePortRpcSession<TestGadget>(port1)
  return {
    stub: client as unknown as RpcStub<TestGadget>,
    break: () => host[Symbol.dispose](),
  }
}

// A connect that hangs rather than fails: the shape of an in-flight pipelined call whose stub was
// disposed under it. It is not a rejection, so nothing downstream ever hears about it.
function neverSettles() {
  return new Promise<never>(() => {})
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms))
}

function dispatchIframeHandshake(iframe: HTMLIFrameElement, port: MessagePort) {
  window.dispatchEvent(new MessageEvent('message', {
    data: 'handshake',
    origin: 'null',
    source: iframe.contentWindow,
    ports: [port],
  }))
}

describe('GadgetUI RPC recovery', () => {
  let container: HTMLDivElement
  let root: Root
  const childSessions: RpcStub<TestGadget>[] = []

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    vi.useRealTimers()
    for (const session of childSessions.splice(0)) session[Symbol.dispose]()
    await act(async () => root.unmount())
    container.remove()
  })

  function connectIframe(iframe: HTMLIFrameElement) {
    const { port1, port2 } = new MessageChannel()
    const child = newMessagePortRpcSession<TestGadget>(port1)
    childSessions.push(child)
    dispatchIframeHandshake(iframe, port2)
    return child
  }

  it('lays out gadget UI against the device-width viewport', async () => {
    const gadget = fakeGadget('responsive', 'document.body.textContent = "responsive"')
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    expect(container.querySelector('iframe')!.srcdoc).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    )
  })

  it('keeps the iframe while redirecting calls to the replacement gadget client', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    const firstChild = connectIframe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('first')
    await expect((firstChild as any).child().read()).resolves.toBe('first')

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })

    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())
    expect(container.querySelector('iframe')).toBe(firstIframe)
    await expect(firstChild.read()).resolves.toBe('replacement')
    await expect((firstChild as any).child().read()).resolves.toBe('replacement')
  })

  it('queues calls while the replacement connection is pending', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
      vi.fn(() => connection.promise),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalledOnce())

    const read = child.read()
    const replacementStub = new RpcStub(
      new TestGadgetTarget('replacement'),
    ) as unknown as RpcStub<TestGadget>
    connection.resolve(replacementStub)

    await expect(read).resolves.toBe('replacement')
    expect(container.querySelector('iframe')).toBe(iframe)
  })

  it('abandons queued calls when a code reload replaces the iframe', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(connection.promise)
      .mockResolvedValueOnce(
        new RpcStub(new TestGadgetTarget('reloaded')) as unknown as RpcStub<TestGadget>,
      )
    const replacement = fakeGadget('replacement', 'unused', connectToGadget)
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" reloadTrigger={0} />)
    })
    const read = child.read()

    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" reloadTrigger={1} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(iframe))
    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(read).rejects.toBeDefined()
    await expect(reloadedChild.read()).resolves.toBe('reloaded')
  })

  it('re-subscribes disposed callbacks without restoring an intentional unsubscribe', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    const values: string[] = []
    let callbacks: TestCallbacks | undefined
    let subscription: RpcStub<TestSubscription> | undefined
    let subscribeCount = 0
    const subscribe = async () => {
      callbacks = new TestCallbacks(values, () => void subscribe())
      subscription = await child.subscribe(callbacks) as unknown as RpcStub<TestSubscription>
      subscribeCount++
    }
    await subscribe()
    expect(values).toEqual(['first'])

    const replacement = fakeGadget('replacement', 'unused')
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(values).toEqual(['first', 'replacement']))
    expect(container.querySelector('iframe')).toBe(iframe)

    callbacks!.closed = true
    subscription![Symbol.dispose]()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(subscribeCount).toBe(2)
  })

  it('reloads after a replacement timeout and disposes the late capability', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const connection = deferred<RpcStub<TestGadget>>()
    const replacement = fakeGadget('replacement', 'unused', vi.fn(() => connection.promise))
    vi.useFakeTimers()
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    expect(replacement.connectToGadget).toHaveBeenCalledOnce()
    const read = child.read()

    await act(async () => vi.advanceTimersByTimeAsync(5_000))
    vi.useRealTimers()
    await expect(read).rejects.toBeDefined()
    expect(container.querySelector('iframe')).not.toBe(iframe)

    const disposed = vi.fn<() => void>()
    connection.resolve(
      new RpcStub(new TestGadgetTarget('late', disposed)) as unknown as RpcStub<TestGadget>,
    )
    await connection.promise
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
  })

  it('ignores a superseded replacement connection', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    const staleConnection = deferred<RpcStub<TestGadget>>()
    const stale = fakeGadget('stale', 'unused', vi.fn(() => staleConnection.promise))
    await act(async () => root.render(<GadgetUI gadget={stale.stub} height="100px" />))
    await vi.waitFor(() => expect(stale.connectToGadget).toHaveBeenCalledOnce())

    const current = fakeGadget('current', 'unused')
    await act(async () => root.render(<GadgetUI gadget={current.stub} height="100px" />))
    await vi.waitFor(() => expect(current.connectToGadget).toHaveBeenCalledOnce())
    await expect(child.read()).resolves.toBe('current')

    const disposed = vi.fn<() => void>()
    staleConnection.resolve(
      new RpcStub(new TestGadgetTarget('stale', disposed)) as unknown as RpcStub<TestGadget>,
    )
    await staleConnection.promise
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe('current')
  })

  it('ignores an old bundle that resolves after the gadget client is replaced', async () => {
    const oldBundle = deferred<UiBundle>()
    const first = fakeGadget('first', 'unused')
    first.getUiBundle.mockReturnValue(oldBundle.promise)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    await vi.waitFor(() => {
      expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    })

    await act(async () => {
      oldBundle.resolve({ jsCode: 'document.body.textContent = "stale"' })
      await oldBundle.promise
    })

    expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('stale')
  })

  it('ignores an old bundle while its replacement is hidden', async () => {
    const oldBundle = deferred<UiBundle>()
    const first = fakeGadget('first', 'unused')
    first.getUiBundle.mockReturnValue(oldBundle.promise)
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" isVisible={false} />)
    })
    expect(replacement.getUiBundle).not.toHaveBeenCalled()

    await act(async () => {
      oldBundle.resolve({ jsCode: 'document.body.textContent = "stale"' })
      await oldBundle.promise
    })

    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" isVisible />)
    })
    await vi.waitFor(() => {
      expect(replacement.getUiBundle).toHaveBeenCalledOnce()
      expect(container.querySelector('iframe')?.srcdoc).toContain('replacement')
    })
    expect(container.querySelector('iframe')?.srcdoc).not.toContain('stale')
  })

  // The regression that produced an intermittently blank gadget iframe on a fresh navigation. A
  // `gadget` change during an in-flight handshake used to reload the iframe, which re-entered the
  // same window and could loop for as long as the props churned. It must instead let the handshake
  // finish and redirect it -- the frame is never thrown away, and the stale stub is never used.
  it('keeps the iframe and redirects a handshake that was superseded mid-flight', async () => {
    const oldConnection = deferred<RpcStub<TestGadget>>()
    const first = fakeGadget(
      'first',
      'document.body.textContent = "first"',
      vi.fn(() => oldConnection.promise),
    )
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const firstIframe = container.querySelector('iframe')!
    const child = connectIframe(firstIframe)

    const replacement = fakeGadget(
      'replacement',
      'document.body.textContent = "replacement"',
    )
    await act(async () => {
      root.render(<GadgetUI gadget={replacement.stub} height="100px" />)
    })
    // No reload: the handshake is still pending, so the frame is left alone.
    expect(container.querySelector('iframe')).toBe(firstIframe)
    expect(replacement.connectToGadget).not.toHaveBeenCalled()

    const disposed = vi.fn<() => void>()
    await act(async () => {
      oldConnection.resolve(
        new RpcStub(new TestGadgetTarget('stale', disposed)) as unknown as RpcStub<TestGadget>,
      )
      await oldConnection.promise
    })

    // The superseded stub is connected but immediately redirected, so it is disposed unused and
    // the frame ends up talking to the replacement over its original port.
    await vi.waitFor(() => expect(disposed).toHaveBeenCalledOnce())
    expect(replacement.connectToGadget).toHaveBeenCalledOnce()
    expect(container.querySelector('iframe')).toBe(firstIframe)
    await expect(child.read()).resolves.toBe('replacement')
  })

  it('ignores a handshake rejection from an iframe that was reloaded', async () => {
    const oldConnection = deferred<RpcStub<TestGadget>>()
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockReturnValueOnce(oldConnection.promise)
      .mockResolvedValueOnce(
        new RpcStub(new TestGadgetTarget('reloaded')) as unknown as RpcStub<TestGadget>,
      )
    const gadget = fakeGadget(
      'initial',
      'document.body.textContent = "bundle"',
      connectToGadget,
    )
    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const oldIframe = container.querySelector('iframe')!
    dispatchIframeHandshake(oldIframe, new MessageChannel().port2)

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" reloadTrigger={1} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBe(oldIframe))

    await act(async () => {
      oldConnection.reject(new Error('old connection lost'))
      await oldConnection.promise.catch(() => {})
    })
    expect(container.querySelector('iframe')).not.toBeNull()

    const reloadedChild = connectIframe(container.querySelector('iframe')!)
    await expect(reloadedChild.read()).resolves.toBe('reloaded')
  })

  // ── adversarial `gadget` churn ────────────────────────────────────────────────
  //
  // The blank-iframe bug was a restart loop, so the interesting property is not "one churn is
  // handled" but "arbitrary churn terminates". These drive far more prop churn than a real
  // navigation would and assert the invariants that make the frame paint: exactly one iframe,
  // never remounted; the frame always ends up with a live connection; and the amount of work is
  // bounded rather than proportional to the churn.

  const CHURN_ROUNDS = 25

  it('damps a churn storm during the handshake into a single redirect', async () => {
    const opening = deferred<RpcStub<TestGadget>>()
    const first = fakeGadget('first', 'document.body.textContent = "first"', vi.fn(() => opening.promise))
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)

    // Churn the stub identity hard while the handshake is still in flight.
    const churn = Array.from({ length: CHURN_ROUNDS }, (_, i) => fakeGadget(`churn-${i}`, 'unused'))
    for (const next of churn) {
      await act(async () => {
        root.render(<GadgetUI gadget={next.stub} height="100px" />)
      })
      // The invariant that was violated before: the frame is never thrown away mid-handshake.
      expect(container.querySelectorAll('iframe')).toHaveLength(1)
      expect(container.querySelector('iframe')).toBe(iframe)
    }
    // No restart means no wasted connection attempts either -- every one of these would have been
    // a fresh iframe plus a fresh handshake under the old behaviour.
    for (const next of churn) expect(next.connectToGadget).not.toHaveBeenCalled()

    const last = churn[churn.length - 1]
    await act(async () => {
      opening.resolve(new RpcStub(new TestGadgetTarget('stale')) as unknown as RpcStub<TestGadget>)
      await opening.promise
    })

    // Bounded work: CHURN_ROUNDS changes collapse into exactly one reconnect, against the newest
    // stub, and only the newest stub.
    await vi.waitFor(() => expect(last.connectToGadget).toHaveBeenCalledOnce())
    for (const next of churn.slice(0, -1)) expect(next.connectToGadget).not.toHaveBeenCalled()
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe(`churn-${CHURN_ROUNDS - 1}`)
  })

  it('keeps one live connection through churn that straddles the handshake', async () => {
    const opening = deferred<RpcStub<TestGadget>>()
    const first = fakeGadget('first', 'document.body.textContent = "first"', vi.fn(() => opening.promise))
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)

    // Half the churn lands before the handshake settles and half after, so the component has to
    // cross from the "deferred reconnect" path to the "live redirect" path without dropping the
    // frame or the calls riding on it.
    const before = Array.from({ length: CHURN_ROUNDS }, (_, i) => fakeGadget(`before-${i}`, 'unused'))
    for (const next of before) {
      await act(async () => root.render(<GadgetUI gadget={next.stub} height="100px" />))
    }

    // A call issued while everything is in flight must still be answered -- by the settled
    // connection, never by a stale stub and never by a promise that hangs.
    const inFlight = child.read()

    await act(async () => {
      opening.resolve(new RpcStub(new TestGadgetTarget('stale')) as unknown as RpcStub<TestGadget>)
      await opening.promise
    })

    const after = Array.from({ length: CHURN_ROUNDS }, (_, i) => fakeGadget(`after-${i}`, 'unused'))
    for (const next of after) {
      await act(async () => root.render(<GadgetUI gadget={next.stub} height="100px" />))
      expect(container.querySelector('iframe')).toBe(iframe)
    }

    const final = `after-${CHURN_ROUNDS - 1}`
    await vi.waitFor(() => expect(after[after.length - 1].connectToGadget).toHaveBeenCalledOnce())
    await expect(inFlight).resolves.toBeTypeOf('string')
    await expect(child.read()).resolves.toBe(final)
    expect(container.querySelectorAll('iframe')).toHaveLength(1)
    expect(container.querySelector('iframe')).toBe(iframe)
    // Every redirect connects at most once, so the churn never compounds.
    for (const next of after) expect(next.connectToGadget).toHaveBeenCalledTimes(1)
  })

  it('reconnects a code reload that lands together with gadget churn', async () => {
    // The "a page already open when a code:write lands stays blank" repro: the new code invalidates
    // the bundle and remounts the iframe, while the editor re-derives the gadget stub at the same
    // moment. The replacement frame has to end up connected, not blank.
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" reloadTrigger={0} />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    for (let round = 1; round <= 5; round++) {
      const written = fakeGadget(`written-${round}`, `document.body.textContent = "v${round}"`)
      const churned = fakeGadget(`churned-${round}`, `document.body.textContent = "v${round}"`)
      await act(async () => {
        root.render(<GadgetUI gadget={written.stub} height="100px" reloadTrigger={round} />)
      })
      // ...and the stub identity churns while the reloaded frame is still handshaking.
      await act(async () => {
        root.render(<GadgetUI gadget={churned.stub} height="100px" reloadTrigger={round} />)
      })
      await vi.waitFor(() => {
        expect(container.querySelector('iframe')?.srcdoc).toContain(`v${round}`)
      })
      expect(container.querySelectorAll('iframe')).toHaveLength(1)
      const reloaded = connectIframe(container.querySelector('iframe')!)
      await expect(reloaded.read()).resolves.toBe(`churned-${round}`)
    }
  })

  // ── a handshake that is never answered ────────────────────────────────────────
  //
  // The residual prod failure after the remount fix: the iframe exists with its full bundle, no
  // error panel is painted, and nothing ever appears. The gadget's own script posts its handshake
  // and then awaits RPC before its first paint, so its try/catch cannot help -- an unanswered
  // handshake is a promise that never settles, not one that rejects. Every one of these asserts
  // that the frame ends up either connected or visibly failed, never silently waiting.

  const HANDSHAKE_TIMEOUT_MS = 6_000
  const WATCHDOG_MS = 23_000

  // Fake timers only capture timers scheduled after they are installed, and the deadlines under
  // test are armed as the frame mounts -- so these tests have to be faked from the very start. The
  // bundle load resolves through microtasks, which `act` flushes regardless.
  async function renderFaked(ui: Parameters<Root['render']>[0]) {
    await act(async () => {
      root.render(ui)
    })
  }


  it('retries onto the replacement stub when the first connect hangs instead of failing', async () => {
    // `gadget` is a pipelined stub; when GadgetEditor re-derives it (which is what a code:merge
    // does) the old one is disposed, and an in-flight pipelined call on a disposed stub is
    // *cancelled* -- it never settles and never rejects. Awaiting it unbounded strands the frame.
    vi.useFakeTimers()
    const hung = fakeGadget('hung', 'document.body.textContent = "hung"', vi.fn(neverSettles))
    await renderFaked(<GadgetUI gadget={hung.stub} height="100px" />)
    const iframe = container.querySelector('iframe')!
    expect(iframe).not.toBeNull()
    const child = connectIframe(iframe)

    // The editor swaps in a working stub, exactly as it does after the merge settles.
    const replacement = fakeGadget('replacement', 'unused')
    await renderFaked(<GadgetUI gadget={replacement.stub} height="100px" />)
    expect(replacement.connectToGadget).not.toHaveBeenCalled()

    await advance(HANDSHAKE_TIMEOUT_MS)
    vi.useRealTimers()

    // The hung attempt is abandoned and the retry lands on the stub that works.
    await vi.waitFor(() => expect(replacement.connectToGadget).toHaveBeenCalled())
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.querySelector('[data-testid="gadget-error"]')).toBeNull()
    await expect(child.read()).resolves.toBe('replacement')
  })

  it('waits for a gadget stub that has not arrived when the frame handshakes', async () => {
    const first = fakeGadget('first', 'document.body.textContent = "first"')
    await act(async () => {
      root.render(<GadgetUI gadget={first.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!

    // The bundle is already loaded, so the frame stays mounted while the stub goes missing.
    await act(async () => {
      root.render(<GadgetUI gadget={undefined as never} height="100px" />)
    })
    const child = connectIframe(iframe)

    const arrived = fakeGadget('arrived', 'unused')
    await act(async () => {
      root.render(<GadgetUI gadget={arrived.stub} height="100px" />)
    })

    vi.useFakeTimers()
    await act(async () => vi.advanceTimersByTimeAsync(500))
    vi.useRealTimers()

    await vi.waitFor(() => expect(arrived.connectToGadget).toHaveBeenCalled())
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe('arrived')
  })

  it('shows a visible error when every connect attempt hangs', async () => {
    vi.useFakeTimers()
    const hung = fakeGadget('hung', 'document.body.textContent = "hung"', vi.fn(neverSettles))
    await renderFaked(<GadgetUI gadget={hung.stub} height="100px" />)
    expect(container.querySelector('iframe')).not.toBeNull()
    connectIframe(container.querySelector('iframe')!)

    await advance(HANDSHAKE_TIMEOUT_MS * 3 + 1_000)
    vi.useRealTimers()

    // Bounded: it gives up rather than retrying forever, and it says so on screen.
    expect(hung.connectToGadget).toHaveBeenCalledTimes(3)
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="gadget-error"]')).not.toBeNull()
    })
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('surfaces an error when the frame never handshakes at all', async () => {
    // Covers the causes we have not diagnosed: a handshake lost before it reaches the listener, or
    // a frame whose script dies before posting one. The pane must not stay blank and silent.
    vi.useFakeTimers()
    const silent = fakeGadget('silent', 'document.body.textContent = "silent"')
    await renderFaked(<GadgetUI gadget={silent.stub} height="100px" />)
    expect(container.querySelector('iframe')).not.toBeNull()
    expect(container.querySelector('[data-testid="gadget-error"]')).toBeNull()

    await advance(WATCHDOG_MS + 1_000)
    vi.useRealTimers()

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="gadget-error"]')).not.toBeNull()
    })
  })

  it('leaves a healthy frame alone once the watchdog deadline passes', async () => {
    vi.useFakeTimers()
    const healthy = fakeGadget('healthy', 'document.body.textContent = "healthy"')
    await renderFaked(<GadgetUI gadget={healthy.stub} height="100px" />)
    const iframe = container.querySelector('iframe')!
    expect(iframe).not.toBeNull()
    const child = connectIframe(iframe)
    await advance(0)

    await advance(WATCHDOG_MS * 2)
    vi.useRealTimers()

    expect(container.querySelector('[data-testid="gadget-error"]')).toBeNull()
    expect(container.querySelector('iframe')).toBe(iframe)
    await expect(child.read()).resolves.toBe('healthy')
  })

  // ── a stub that breaks under a connected frame ────────────────────────────────
  //
  // When the backend RPC socket flaps, every capability the page holds breaks at once. The frame
  // keeps its session, so the handshake watchdog stays quiet, but its calls are parked on the
  // suspension gate -- and the gate used to be lowered only by a `gadget` prop change, which a
  // flap does not reliably produce. The result was a blank pane with a live session and no error:
  // invisible to every guard, and exactly what prod showed.

  it('recovers on its own when the gadget stub breaks and no new prop arrives', async () => {
    const first = breakableConnection('first')
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>()
      .mockResolvedValueOnce(first.stub)
      .mockResolvedValue(breakableConnection('recovered').stub)
    const gadget = fakeGadget('gadget', 'document.body.textContent = "gadget"', connectToGadget)

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const child = connectIframe(iframe)
    await expect(child.read()).resolves.toBe('first')

    // The backend drops the connection. Crucially, nothing re-renders afterwards: no new stub, no
    // new chatId, no reload. The component is on its own.
    await act(async () => {
      first.break()
      await Promise.resolve()
    })

    await vi.waitFor(() => expect(connectToGadget).toHaveBeenCalledTimes(2), { timeout: 5_000 })
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(container.querySelector('[data-testid="gadget-error"]')).toBeNull()
    await expect(child.read()).resolves.toBe('recovered')
  })

  it('gives up visibly when the gadget connection will not stay up', async () => {
    // A sustained outage must not become an endless reconnect loop, and must not end in silence.
    const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadget>>>(async () => {
      const connection = breakableConnection('doomed')
      // Breaks as soon as it is handed over, so every recovery attempt fails the same way.
      queueMicrotask(() => connection.break())
      return connection.stub
    })
    const gadget = fakeGadget('gadget', 'document.body.textContent = "gadget"', connectToGadget)

    await act(async () => {
      root.render(<GadgetUI gadget={gadget.stub} height="100px" />)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    connectIframe(container.querySelector('iframe')!)

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="gadget-error"]')).not.toBeNull()
    }, { timeout: 20_000 })
    // Bounded: the ladder stops rather than reconnecting forever.
    expect(connectToGadget.mock.calls.length).toBeLessThanOrEqual(8)
  }, 30_000)
})
