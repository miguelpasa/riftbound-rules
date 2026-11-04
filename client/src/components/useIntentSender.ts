import { useCallback, useEffect, useRef, useState } from 'react';
import type { Intent } from '@riftbound/engine';
import { useGame } from '../app/gameApi';

/** Sends intents through the GameApi and tracks the pending flag and the last rule error message. */
export function useIntentSender(): {
  send: (intent: Intent) => Promise<boolean>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
} {
  const api = useGame();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(
    async (intent: Intent): Promise<boolean> => {
      setPending(true);
      setError(null);
      try {
        const r = await api.send(intent);
        if (!r.ok && alive.current) setError(r.message);
        return r.ok;
      } catch (e) {
        if (alive.current) setError(e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        if (alive.current) setPending(false);
      }
    },
    [api],
  );

  const clearError = useCallback(() => setError(null), []);
  return { send, pending, error, clearError };
}
