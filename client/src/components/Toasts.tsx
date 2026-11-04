import { useEffect } from 'react';
import { dismissToast, pushToast, useGameStore, type Toast } from '../store/gameStore';

const AUTO_DISMISS_MS = 6000;
const RULE_ERROR_PREFIX = '[Rule Error]';

/** Shows a rule-engine rejection as an error toast. Returns the toast id. */
export function toastFromRuleError(err: { message: string }): number {
  const text = err.message.startsWith(RULE_ERROR_PREFIX)
    ? err.message
    : `${RULE_ERROR_PREFIX} ${err.message}`;
  return pushToast(text);
}

function ToastItem({ toast }: { toast: Toast }) {
  useEffect(() => {
    const timer = window.setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [toast.id]);

  const isError = toast.text.startsWith(RULE_ERROR_PREFIX);
  const tone = isError
    ? 'border-rose-700 bg-rose-950 text-rose-100'
    : 'border-slate-600 bg-slate-800 text-slate-100';

  return (
    <button
      type="button"
      title="Click to dismiss"
      onClick={() => dismissToast(toast.id)}
      className={`pointer-events-auto rounded-lg border px-4 py-2 text-left text-sm shadow-lg hover:brightness-110 focus-visible:outline-2 focus-visible:outline-amber-300 ${tone}`}
    >
      {toast.text}
    </button>
  );
}

/** Stack of store toasts. The live region is always mounted so announcements are read reliably. */
export function Toasts() {
  const toasts = useGameStore((s) => s.toasts);

  return (
    <div
      aria-live="assertive"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
