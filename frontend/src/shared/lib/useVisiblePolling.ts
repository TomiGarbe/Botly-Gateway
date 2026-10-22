import { useEffect, useRef } from 'react'

/** Polls only while the tab is visible and refreshes immediately when it becomes visible again. */
export function useVisiblePolling(callback: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(callback)
  useEffect(() => { latest.current = callback }, [callback])

  useEffect(() => {
    if (!enabled) return undefined
    let timer: number | undefined
    const start = () => { if (timer === undefined) timer = window.setInterval(() => latest.current(), intervalMs) }
    const stop = () => { if (timer !== undefined) { window.clearInterval(timer); timer = undefined } }
    const onVisibility = () => {
      if (document.hidden) { stop(); return }
      latest.current()
      start()
    }
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [intervalMs, enabled])
}
