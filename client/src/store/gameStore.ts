import { useSyncExternalStore } from 'react';
import type { CardDatabase, ClientGameState } from '@riftbound/engine';

export interface Toast {
  id: number;
  text: string;
}

export interface GameStoreState {
  cards: CardDatabase | null;
  view: ClientGameState | null;
  status: string;
  toasts: Toast[];
  /** Epoch ms when the running host timer fires (null = none). Read by ChainInspector. */
  deadline: number | null;
}

type Listener = () => void;

let state: GameStoreState = {
  cards: null,
  view: null,
  status: 'Starting',
  toasts: [],
  deadline: null,
};

const listeners = new Set<Listener>();
let nextToastId = 1;

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getState(): GameStoreState {
  return state;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shallow-merges a patch into the store and notifies subscribers if anything changed. */
export function setState(
  patch: Partial<GameStoreState> | ((current: GameStoreState) => Partial<GameStoreState>),
): void {
  const delta = typeof patch === 'function' ? patch(state) : patch;
  const changed = (Object.keys(delta) as (keyof GameStoreState)[]).some(
    (key) => !Object.is(delta[key], state[key]),
  );
  if (!changed) {
    return;
  }
  state = { ...state, ...delta };
  emit();
}

/** Adds a toast and returns its id. */
export function pushToast(text: string): number {
  const id = nextToastId++;
  setState((current) => ({ toasts: [...current.toasts, { id, text }] }));
  return id;
}

export function dismissToast(id: number): void {
  setState((current) => ({ toasts: current.toasts.filter((toast) => toast.id !== id) }));
}

/**
 * Subscribes a component to a slice of the store. Selectors should return
 * primitives or existing references; a selector that builds a fresh object on
 * every call makes the snapshot unstable and causes re-render loops.
 */
export function useGameStore<T>(selector: (current: GameStoreState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(state),
  );
}
