import { useSyncExternalStore } from 'react'

// A tiny shared store for state that outlives pages (uploads, the breadcrumb name): replace the value, subscribers re-render.
export function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set(next: T | ((prev: T) => T)) {
      value = typeof next === 'function' ? (next as (prev: T) => T)(value) : next
      listeners.forEach((l) => l())
    },
    use: () =>
      useSyncExternalStore(
        (l) => (listeners.add(l), () => void listeners.delete(l)),
        () => value,
      ),
  }
}
