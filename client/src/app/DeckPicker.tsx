import { useEffect, useMemo, useState } from 'react';
import type { CardDatabase, DeckList } from '@riftbound/engine';
import {
  clearCustomDeck,
  importDeckList,
  loadCustomDeck,
  loadSelectedDeckId,
  saveCustomDeck,
  saveSelectedDeckId,
} from '../decks/deckStorage';
import type { PresetDeck } from '../decks/presets';

export interface DeckChoice {
  id: string;
  name: string;
  deck: DeckList;
}

export const PARTIAL_WARNING =
  'Cards marked partial have rules text that is not executed in this version';

const CUSTOM_ID = 'custom';
export const DECK_SIZE_LABEL = 40;

export interface DeckPickerProps {
  presets: PresetDeck[];
  cards: CardDatabase;
  onChange: (choice: DeckChoice | null) => void;
}

function domainsOf(preset: PresetDeck, cards: CardDatabase): string {
  const d = cards[preset.legendId]?.domains ?? [];
  return d.length === 0 ? 'Colorless' : d.join(' / ');
}

/** Preset list + 'Import deck JSON'. Remembers the last choice through deckStorage. */
export function DeckPicker({ presets, cards, onChange }: DeckPickerProps) {
  const custom = useMemo<DeckChoice | null>(() => {
    const stored = loadCustomDeck();
    if (!stored) return null;
    const verdict = importDeckList(stored, cards);
    return verdict.ok ? { id: CUSTOM_ID, name: 'Imported deck', deck: verdict.deck } : null;
  }, [cards]);
  const [imported, setImported] = useState<DeckChoice | null>(custom);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const saved = loadSelectedDeckId();
    if (saved === CUSTOM_ID && custom) return CUSTOM_ID;
    if (saved && presets.some((p) => p.id === saved)) return saved;
    return presets[0]?.id ?? (custom ? CUSTOM_ID : null);
  });
  const [text, setText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);

  const choice = useMemo<DeckChoice | null>(() => {
    if (selectedId === CUSTOM_ID) return imported;
    const p = presets.find((x) => x.id === selectedId);
    return p ? { id: p.id, name: p.name, deck: p.deck } : null;
  }, [selectedId, presets, imported]);

  useEffect(() => {
    onChange(choice);
  }, [choice, onChange]);

  const select = (id: string): void => {
    setSelectedId(id);
    saveSelectedDeckId(id);
  };

  const doImport = (): void => {
    const res = importDeckList(text, cards);
    if (!res.ok) {
      setErrors(res.errors);
      return;
    }
    setErrors([]);
    saveCustomDeck(res.deck);
    setImported({ id: CUSTOM_ID, name: 'Imported deck', deck: res.deck });
    select(CUSTOM_ID);
    setText('');
  };

  return (
    <section aria-label="Choose a deck" className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold text-slate-100">Choose a deck</h2>
      <div role="radiogroup" aria-label="Decks" className="flex flex-col gap-2">
        {presets.map((p) => {
          const checked = selectedId === p.id;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => select(p.id)}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-amber-300 ${
                checked
                  ? 'border-amber-300 bg-slate-800'
                  : 'border-slate-700 bg-slate-900 hover:bg-slate-800'
              }`}
            >
              <span>
                <span className="block font-medium text-slate-100">{p.name}</span>
                <span className="block text-xs text-slate-400">{domainsOf(p, cards)}</span>
              </span>
              <span className="flex items-center gap-1 text-xs">
                <span
                  className={`rounded-full px-2 py-0.5 ${
                    p.stats.partialCount === 0
                      ? 'bg-emerald-900 text-emerald-200'
                      : 'bg-amber-900 text-amber-200'
                  }`}
                >
                  {p.stats.fullSupportCount}/{DECK_SIZE_LABEL} cards fully implemented
                </span>
                {p.stats.partialCount > 0 ? (
                  <span
                    role="img"
                    title={PARTIAL_WARNING}
                    aria-label={PARTIAL_WARNING}
                    className="cursor-help text-amber-300"
                  >
                    {'⚠'}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
        {imported ? (
          <div
            role="radio"
            aria-checked={selectedId === CUSTOM_ID}
            tabIndex={0}
            onClick={() => select(CUSTOM_ID)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                select(CUSTOM_ID);
              }
            }}
            className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 focus-visible:outline-2 focus-visible:outline-amber-300 ${
              selectedId === CUSTOM_ID
                ? 'border-amber-300 bg-slate-800'
                : 'border-slate-700 bg-slate-900 hover:bg-slate-800'
            }`}
          >
            <span className="font-medium text-slate-100">Imported deck</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                clearCustomDeck();
                setImported(null);
                if (selectedId === CUSTOM_ID) setSelectedId(presets[0]?.id ?? null);
              }}
              className="text-xs text-slate-400 underline hover:text-slate-200"
            >
              Remove
            </button>
          </div>
        ) : null}
        {presets.length === 0 && !imported ? (
          <p className="text-sm text-amber-300">No decks available.</p>
        ) : null}
      </div>

      <details className="rounded-lg border border-slate-800 p-2">
        <summary className="cursor-pointer text-sm text-slate-300">Import deck JSON</summary>
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-xs text-slate-400" htmlFor="deck-json">
            Paste a deck list ({'{'} legendId, championId, mainDeck, runeDeck, battlefields {'}'})
          </label>
          <textarea
            id="deck-json"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            className="w-full rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100"
          />
          <button
            type="button"
            onClick={doImport}
            disabled={text.trim() === ''}
            className="self-start rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-600 disabled:opacity-40"
          >
            Import deck
          </button>
          {errors.length > 0 ? (
            <ul role="alert" className="list-disc pl-5 text-xs text-rose-300">
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </section>
  );
}
