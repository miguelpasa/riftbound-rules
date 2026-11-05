import { getState, pushToast } from '../store/gameStore';

/** Pushes a toast unless one with the same text is already showing. */
export function pushToastOnce(text: string): void {
  if (getState().toasts.some((t) => t.text === text)) return;
  pushToast(text);
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
