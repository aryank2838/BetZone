import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useVisibleInterval } from './useVisibleInterval';

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useVisibleInterval', () => {
  beforeEach(() => { vi.useFakeTimers(); setVisibility('visible'); });
  afterEach(() => { vi.useRealTimers(); setVisibility('visible'); });

  it('runs on each tick while visible', () => {
    const callback = vi.fn();
    renderHook(() => useVisibleInterval(callback, 1000));
    vi.advanceTimersByTime(3000);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it('skips ticks while hidden and refreshes once when visible again', () => {
    const callback = vi.fn();
    renderHook(() => useVisibleInterval(callback, 1000));
    setVisibility('hidden');
    vi.advanceTimersByTime(5000);
    expect(callback).not.toHaveBeenCalled();
    setVisibility('visible');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const callback = vi.fn();
    renderHook(() => useVisibleInterval(callback, 1000, false));
    vi.advanceTimersByTime(3000);
    setVisibility('hidden');
    setVisibility('visible');
    expect(callback).not.toHaveBeenCalled();
  });
});
