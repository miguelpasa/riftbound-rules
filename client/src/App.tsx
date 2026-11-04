import { useEffect, useState } from 'react';
import { loadCards } from './cards/loadCards';
import { dismissToast, setState, useGameStore } from './store/gameStore';

const PLACEHOLDER_ACTIONS = ['Host Game', 'Join Game', 'Play vs AI', 'Tutorial'];

interface Banner {
  ok: boolean;
  text: string;
}

export function App() {
  const status = useGameStore((s) => s.status);
  const toasts = useGameStore((s) => s.toasts);
  const [banner, setBanner] = useState<Banner | null>(null);

  useEffect(() => {
    let active = true;
    loadCards().then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        const text = `Loaded ${Object.keys(result.cards).length} cards`;
        setState({ cards: result.cards, status: text });
        setBanner({ ok: true, text });
      } else {
        setState({ status: result.message });
        setBanner({ ok: false, text: result.message });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8">
        <header>
          <h1 className="text-3xl font-bold tracking-tight text-amber-300">
            Riftbound Local Duelist
          </h1>
          <p className="mt-1 text-sm text-slate-400">{status}</p>
        </header>

        {banner && (
          <div
            role="status"
            className={
              banner.ok
                ? 'rounded-lg border border-emerald-700 bg-emerald-950/60 px-4 py-3 text-sm text-emerald-200'
                : 'rounded-lg border border-rose-700 bg-rose-950/60 px-4 py-3 text-sm text-rose-200'
            }
          >
            {banner.text}
          </div>
        )}

        <nav className="flex flex-col gap-3">
          {PLACEHOLDER_ACTIONS.map((label) => (
            <button
              key={label}
              type="button"
              className="w-full rounded-lg bg-slate-800 px-4 py-3 text-left font-medium text-slate-100 hover:bg-slate-700"
            >
              {label}
            </button>
          ))}
        </nav>
      </main>

      {toasts.length > 0 && (
        <div className="fixed bottom-4 left-1/2 flex w-[calc(100%-2rem)] max-w-md -translate-x-1/2 flex-col gap-2">
          {toasts.map((toast) => (
            <button
              key={toast.id}
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="rounded-lg bg-slate-700 px-4 py-2 text-left text-sm shadow-lg"
            >
              {toast.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
