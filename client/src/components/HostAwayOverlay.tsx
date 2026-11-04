import { useId } from 'react';

export type HostAwayStatus = 'connecting' | 'connected' | 'host-away' | 'closed';

export interface HostAwayOverlayProps {
  status: HostAwayStatus;
  onLeave: () => void;
}

const MESSAGES: Record<Exclude<HostAwayStatus, 'connected'>, string> = {
  connecting: 'Connecting...',
  'host-away': 'Host disconnected, waiting for host to return...',
  closed: 'Connection closed.',
};

/** Blocking full-screen overlay shown while the guest is not connected to the host. */
export function HostAwayOverlay({ status, onLeave }: HostAwayOverlayProps) {
  const titleId = useId();

  if (status === 'connected') {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-5 rounded-xl border border-slate-700 bg-slate-900 p-6 text-center">
        {status !== 'closed' && (
          <div
            aria-hidden="true"
            className="h-10 w-10 rounded-full border-4 border-slate-700 border-t-amber-300 motion-safe:animate-spin"
          />
        )}
        <p id={titleId} role="status" className="text-base text-slate-200">
          {MESSAGES[status]}
        </p>
        <button
          type="button"
          onClick={onLeave}
          autoFocus
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-slate-100 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-amber-300"
        >
          Leave game
        </button>
      </div>
    </div>
  );
}
