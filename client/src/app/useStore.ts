import { useSyncExternalStore } from 'react';
import type { Store } from './store';

const noopSubscribe = (): (() => void) => () => undefined;

/** Reads a Store (or null) from React. */
export function useStore<T extends object>(store: Store<T> | null): T | null {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.get : () => null,
    store ? store.get : () => null,
  );
}
