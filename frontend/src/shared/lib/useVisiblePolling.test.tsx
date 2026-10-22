// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useVisiblePolling } from './useVisiblePolling'

function Poller({ onTick }: { onTick: () => void }) { useVisiblePolling(onTick, 1000); return null }

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('useVisiblePolling', () => {
  afterEach(() => { cleanup(); vi.useRealTimers(); setHidden(false) })

  it('pauses while hidden and refreshes on return', () => {
    vi.useFakeTimers()
    const onTick = vi.fn()
    render(<Poller onTick={onTick} />)
    vi.advanceTimersByTime(2000)
    expect(onTick).toHaveBeenCalledTimes(2)
    setHidden(true)
    vi.advanceTimersByTime(5000)
    expect(onTick).toHaveBeenCalledTimes(2)
    setHidden(false)
    expect(onTick).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1000)
    expect(onTick).toHaveBeenCalledTimes(4)
  })
})
