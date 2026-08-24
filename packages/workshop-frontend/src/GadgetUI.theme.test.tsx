// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RpcStub, RpcTarget } from 'capnweb'
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

import GadgetUI, { GADGET_THEME_MESSAGE_TYPE } from './GadgetUI'
import { ThemeProvider, useTheme } from './ThemeContext'

class TestGadgetTarget extends RpcTarget {
  read() {
    return 'value'
  }
}

function fakeGadget(bundleCode: string) {
  const connectToGadget = vi.fn<() => Promise<RpcStub<TestGadgetTarget>>>(
    async () => new RpcStub(new TestGadgetTarget()),
  )
  const getUiBundle = vi.fn<() => Promise<UiBundle>>(async () => ({ jsCode: bundleCode }))
  return { connectToGadget, getUiBundle } as unknown as RpcStub<GadgetClient>
}

function dispatchIframeHandshake(iframe: HTMLIFrameElement, port: MessagePort) {
  window.dispatchEvent(new MessageEvent('message', {
    data: 'handshake',
    origin: 'null',
    source: iframe.contentWindow,
    ports: [port],
  }))
}

let setHostThemeMode: ((mode: 'light' | 'dark' | 'system') => void) | null = null

function ThemeControl() {
  setHostThemeMode = useTheme().setThemeMode
  return null
}

describe('GadgetUI host theming', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-mode')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.localStorage.clear()
  })

  async function renderGadget(children?: ReactNode) {
    const gadget = fakeGadget('document.body.textContent = "hi"')
    await act(async () => {
      root.render(<>{children}<GadgetUI gadget={gadget} height="100px" /></>)
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    return container.querySelector('iframe')!
  }

  it('seeds the resolved mode into the iframe markup for first paint', async () => {
    document.documentElement.setAttribute('data-mode', 'dark')
    const iframe = await renderGadget()
    expect(iframe.srcdoc).toContain('<html data-mode="dark"')
    expect(iframe.srcdoc).toContain('color-scheme: dark')
  })

  it('seeds light mode when the host is light', async () => {
    document.documentElement.setAttribute('data-mode', 'light')
    const iframe = await renderGadget()
    expect(iframe.srcdoc).toContain('<html data-mode="light"')
  })

  it('posts the theme message into the iframe on handshake', async () => {
    document.documentElement.setAttribute('data-mode', 'dark')
    const iframe = await renderGadget()
    const post = vi.fn<(message: unknown, targetOrigin: string) => void>()
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage: post },
    })

    const { port2 } = new MessageChannel()
    dispatchIframeHandshake(iframe, port2)

    await vi.waitFor(() => expect(post).toHaveBeenCalled())
    expect(post).toHaveBeenCalledWith(
      { type: GADGET_THEME_MESSAGE_TYPE, mode: 'dark', accentColor: null },
      '*',
    )
  })

  it('posts the theme message on iframe load', async () => {
    document.documentElement.setAttribute('data-mode', 'light')
    const iframe = await renderGadget()
    const post = vi.fn<(message: unknown, targetOrigin: string) => void>()
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage: post },
    })

    await act(async () => {
      iframe.dispatchEvent(new Event('load'))
    })

    expect(post).toHaveBeenCalledWith(
      { type: GADGET_THEME_MESSAGE_TYPE, mode: 'light', accentColor: null },
      '*',
    )
  })

  it('re-posts on host theme change without rebuilding the iframe', async () => {
    window.localStorage.setItem('gadgets:theme-mode', 'light')
    const gadget = fakeGadget('document.body.textContent = "hi"')
    await act(async () => {
      root.render(
        <ThemeProvider>
          <ThemeControl />
          <GadgetUI gadget={gadget} height="100px" />
        </ThemeProvider>,
      )
    })
    await vi.waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
    const iframe = container.querySelector('iframe')!
    const srcdocBefore = iframe.srcdoc
    const post = vi.fn<(message: unknown, targetOrigin: string) => void>()
    Object.defineProperty(iframe, 'contentWindow', {
      configurable: true,
      value: { postMessage: post },
    })

    await act(async () => {
      setHostThemeMode!('dark')
    })

    await vi.waitFor(() => expect(post).toHaveBeenCalledWith(
      { type: GADGET_THEME_MESSAGE_TYPE, mode: 'dark', accentColor: null },
      '*',
    ))
    // The running gadget must survive a theme change: same element, same document.
    expect(container.querySelector('iframe')).toBe(iframe)
    expect(iframe.srcdoc).toBe(srcdocBefore)
  })

  it('installs an in-iframe listener that applies the mode to the document element', async () => {
    const iframe = await renderGadget()
    expect(decodeURIComponent(iframe.srcdoc)).toContain("data.type !== 'myoplan-theme'")
    expect(decodeURIComponent(iframe.srcdoc)).toContain('document.documentElement.dataset.mode')
  })
})
