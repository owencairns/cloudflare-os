import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  applyThemeMode,
  readThemeMode,
  resolveThemeMode,
  writeThemeMode,
  type ResolvedThemeMode,
  type ThemeMode,
} from './theme'

interface ThemeContextValue {
  themeMode: ThemeMode
  resolvedThemeMode: ResolvedThemeMode
  setThemeMode: (mode: ThemeMode) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function getInitialThemeState() {
  const themeMode = readThemeMode()
  return { themeMode, resolvedThemeMode: resolveThemeMode(themeMode) }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeState, setThemeState] = useState(getInitialThemeState)
  const { themeMode, resolvedThemeMode } = themeState

  useEffect(() => {
    if (themeMode !== 'system') {
      applyThemeMode(themeMode)
      return
    }

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleChange = () => {
      const nextResolved = applyThemeMode('system')
      setThemeState((prev) => prev.resolvedThemeMode === nextResolved
        ? prev
        : { ...prev, resolvedThemeMode: nextResolved })
    }
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [themeMode])

  const value = useMemo<ThemeContextValue>(() => ({
    themeMode,
    resolvedThemeMode,
    setThemeMode: (mode) => {
      writeThemeMode(mode)
      setThemeState({ themeMode: mode, resolvedThemeMode: applyThemeMode(mode) })
    },
  }), [themeMode, resolvedThemeMode])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used within ThemeProvider')
  return context
}

/**
 * Like `useTheme`, but returns null instead of throwing when no provider is mounted. For components
 * that only *observe* the mode and have a sensible fallback (e.g. reading what is already applied to
 * <html>), so they stay renderable in isolation -- tests, embeds -- without a provider.
 */
export function useOptionalTheme(): ThemeContextValue | null {
  return useContext(ThemeContext)
}
