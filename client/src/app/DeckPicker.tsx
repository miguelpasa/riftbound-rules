import { useEffect, useMemo, useState } from 'react';
import { validateDeck } from '@riftbound/engine';
import type { CardDatabase, DeckList } from '@riftbound/engine';
import {
  deleteImportedDeck,
  listImportedDecks,
  loadSelectedDeckId,
  renameImportedDeck,
  saveImportedDeck,
  saveSelectedDeckId,
  type StoredDeck,
} from '../decks/deckStorage';
import {
  deckContentKey,
  deckSupportStats,
  importDecks,
  isLowSupport,
  LOW_SUPPORT_THRESHOLD,
  type DeckImportEntry,
} from '../decks/deckImport';
import type { PresetDeck } from '../decks/presets';

export interface DeckChoice {
  id: string;
  name: string;
  deck: DeckList;
}

/** Same wording as the in-game card badge ("Effect not implemented"). */
export const PARTIAL_WARNING =
  'Cards marked "Effect not implemented" have rules text that is not executed in this version';

export const LOW_SUPPORT_NOTICE = 'Many cards in this deck have no effect yet';

const lowPercent = Math.round(LOW_SUPPORT_THRESHOLD * 100);

export interface DeckPickerProps {
  presets: PresetDeck[];
  cards: CardDatabase;
  onChange: (choice: DeckChoice | null) => void;
}

function domainsOf(preset: PresetDeck, cards: CardDatabase): string {
  const d = cards[preset.legendId]?.domains ?? [];
  return d.length === 0 ? 'Colorless' : d.join(' / ');
}

function legendLabel(deck: DeckList, cards: CardDatabase): string {
  const l = cards[deck.legendId];
  if (!l) return deck.legendId;
  const d = l.domains;
  return `${l.name} (${d.length === 0 ? 'Colorless' : d.join(' / ')})`;
}

const rowClass = (checked: boolean): string =>
  `flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-amber-300 ${
    checked ? 'border-amber-300 bg-slate-800' : 'border-slate-700 bg-slate-900 hover:bg-slate-800'
  }`;

interface ImportSummary {
  fatal: string[];
  entries: DeckImportEntry[];
  /** Decks whose content is identical to one already stored (or earlier in the same file). */
  duplicates: { index: number; name: string; existingName: string }[];
}

const smallBtn =
  'inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-slate-600 px-3 text-sm text-slate-300 hover:bg-slate-700 hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-amber-300 sm:min-h-0 sm:min-w-0 sm:px-2 sm:py-0.5 sm:text-xs';

/** Preset list, imported decks (multi-deck JSON import) and an import form. */
export function DeckPicker({ presets, cards, onChange }: DeckPickerProps) {
  const [decks, setDecks] = useState<StoredDeck[]>(() => listImportedDecks());
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const saved = loadSelectedDeckId();
    if (saved && (presets.some((p) => p.id === saved) || decks.some((d) => d.id === saved))) {
      return saved;
    }
    return presets[0]?.id ?? decks[0]?.id ?? null;
  });
  const [text, setText] = useState('');
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  // Imported decks are re-validated against the current card data (it may have changed).
  const validity = useMemo(() => {
    const m = new Map<string, { ok: boolean; full: number; total: number; partial: number }>();
    for (const d of decks) {
      const stats = deckSupportStats(d.deck, cards);
      m.set(d.id, { ok: validateDeck(cards, d.deck).ok, ...stats });
    }
    return m;
  }, [decks, cards]);

  const choice = useMemo<DeckChoice | null>(() => {
    const p = presets.find((x) => x.id === selectedId);
    if (p) return { id: p.id, name: p.name, deck: p.deck };
    const d = decks.find((x) => x.id === selectedId);
    if (d && validity.get(d.id)?.ok) return { id: d.id, name: d.name, deck: d.deck };
    return null;
  }, [selectedId, presets, decks, validity]);

  useEffect(() => {
    onChange(choice);
  }, [choice, onChange]);

  const select = (id: string): void => {
    setSelectedId(id);
    saveSelectedDeckId(id);
  };

  const runImport = (source: string): void => {
    const report = importDecks(source, cards);
    const saved: StoredDeck[] = [];
    const duplicates: ImportSummary['duplicates'] = [];
    const known = new Map<string, StoredDeck>();
    for (const d of listImportedDecks()) known.set(deckContentKey(d.deck), d);
    let existingToSelect: StoredDeck | null = null;
    for (const e of report.entries) {
      if (e.ok && e.deck) {
        const key = deckContentKey(e.deck);
        const same = known.get(key);
        if (same) {
          duplicates.push({ index: e.index, name: e.name, existingName: same.name });
          existingToSelect ??= same;
          continue;
        }
        const stored = saveImportedDeck({ name: e.name, deck: e.deck, meta: e.meta });
        known.set(key, stored);
        saved.push(stored);
      }
    }
    setSummary({ fatal: report.fatal, entries: report.entries, duplicates });
    if (saved.length > 0) {
      setDecks(listImportedDecks());
      select(saved[0]!.id);
      setText('');
    } else if (existingToSelect) {
      select(existingToSelect.id);
      setText('');
    }
  };

  const onFile = (file: File | undefined): void => {
    if (!file) return;
    void file
      .text()
      .then(runImport, () =>
        setSummary({ fatal: ['Could not read the selected file.'], entries: [], duplicates: [] }),
      );
  };

  const remove = (id: string): void => {
    deleteImportedDeck(id);
    setDecks(listImportedDecks());
    if (selectedId === id) {
      const rest = decks.filter((d) => d.id !== id);
      setSelectedId(presets[0]?.id ?? rest[0]?.id ?? null);
    }
  };

  const commitRename = (id: string): void => {
    if (renameImportedDeck(id, renameText)) setDecks(listImportedDecks());
    setRenamingId(null);
  };

  const failed = summary?.entries.filter((e) => !e.ok) ?? [];
  const dupIdx = new Set((summary?.duplicates ?? []).map((d) => d.index));
  const okEntries = summary?.entries.filter((e) => e.ok && !dupIdx.has(e.index)) ?? [];

  const selectedStats = ((): { full: number; total: number } | null => {
    const p = presets.find((x) => x.id === selectedId);
    if (p) return { full: p.stats.fullSupportCount, total: p.stats.totalCount };
    const v = selectedId ? validity.get(selectedId) : undefined;
    return v?.ok ? v : null;
  })();
  const lowSupport = selectedStats !== null && isLowSupport(selectedStats);
  const warnings = okEntries.flatMap((e) => e.warnings.map((w) => `${e.name}: ${w}`));

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
              className={rowClass(checked)}
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
                  {p.stats.fullSupportCount}/{p.stats.totalCount} cards fully implemented
                </span>
                {isLowSupport({ full: p.stats.fullSupportCount, total: p.stats.totalCount }) ? (
                  <span className="font-medium text-amber-300">Low coverage</span>
                ) : null}
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
        {decks.map((d) => {
          const v = validity.get(d.id);
          const valid = v?.ok ?? false;
          const checked = selectedId === d.id;
          const rename = renamingId === d.id;
          const detail = [d.meta.eventName, d.meta.placement].filter(Boolean).join(' - ');
          return (
            <div
              key={d.id}
              role="radio"
              aria-checked={checked}
              aria-disabled={!valid}
              aria-label={d.name}
              tabIndex={0}
              onClick={() => valid && select(d.id)}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (valid) select(d.id);
                }
              }}
              className={rowClass(checked)}
            >
              <span>
                {rename ? (
                  <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <input
                      aria-label="Deck name"
                      autoFocus
                      value={renameText}
                      onChange={(e) => setRenameText(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') commitRename(d.id);
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      className="min-h-11 rounded border border-slate-600 bg-slate-950 px-2 text-sm text-slate-100 sm:min-h-0 sm:px-1"
                    />
                    <button
                      type="button"
                      onClick={() => commitRename(d.id)}
                      className={`${smallBtn} text-amber-300`}
                    >
                      Save name
                    </button>
                  </span>
                ) : (
                  <span className="block font-medium text-slate-100">{d.name}</span>
                )}
                <span className="block text-xs text-slate-400">{legendLabel(d.deck, cards)}</span>
                {detail ? <span className="block text-xs text-slate-500">{detail}</span> : null}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs">
                {valid && v ? (
                  <>
                    <span
                      className={`rounded-full px-2 py-0.5 ${
                        v.partial === 0
                          ? 'bg-emerald-900 text-emerald-200'
                          : 'bg-amber-900 text-amber-200'
                      }`}
                    >
                      {v.full}/{v.total} cards fully implemented
                    </span>
                    {isLowSupport(v) ? (
                      <span className="font-medium text-amber-300">Low coverage</span>
                    ) : null}
                    {v.partial > 0 ? (
                      <span
                        role="img"
                        title={PARTIAL_WARNING}
                        aria-label={PARTIAL_WARNING}
                        className="cursor-help text-amber-300"
                      >
                        {'⚠'}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <span className="rounded-full bg-rose-900 px-2 py-0.5 text-rose-200">
                    Not valid with the current card data
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Rename ${d.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingId(d.id);
                    setRenameText(d.name);
                  }}
                  className={smallBtn}
                >
                  Rename
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${d.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(d.id);
                  }}
                  className={smallBtn}
                >
                  Delete
                </button>
              </span>
            </div>
          );
        })}
        {presets.length === 0 && decks.length === 0 ? (
          <p className="text-sm text-amber-300">No decks available.</p>
        ) : null}
      </div>

      {lowSupport && selectedStats ? (
        <p
          role="status"
          aria-label="Deck coverage warning"
          className="rounded-lg border border-amber-700 bg-amber-950 px-3 py-2 text-sm text-amber-200"
        >
          <span aria-hidden="true">{'\u26A0 '}</span>
          {LOW_SUPPORT_NOTICE} ({selectedStats.full} of {selectedStats.total} cards are fully
          implemented, under {lowPercent}%). You can still play it, but the rules text of those
          cards is not executed.
        </p>
      ) : null}

      <details
        className="rounded-lg border border-slate-800 p-2"
        open={summary !== null || undefined}
      >
        <summary className="cursor-pointer text-sm text-slate-300">Import deck JSON</summary>
        <div className="mt-2 flex flex-col gap-2">
          <label className="text-xs text-slate-400" htmlFor="deck-file">
            Load a JSON file (one deck, a list of decks or an object with a decks array)
          </label>
          <input
            id="deck-file"
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const input = e.target;
              onFile(input.files?.[0]);
              input.value = '';
            }}
            className="text-xs text-slate-300"
          />
          <label className="text-xs text-slate-400" htmlFor="deck-json">
            Or paste the JSON here
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
            onClick={() => runImport(text)}
            disabled={text.trim() === ''}
            className="self-start rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-600 disabled:opacity-40"
          >
            Import deck
          </button>
          {summary ? (
            <div role="status" aria-label="Import result" className="text-xs">
              {summary.fatal.length > 0 ? (
                <ul role="alert" className="list-disc pl-5 text-rose-300">
                  {summary.fatal.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-slate-200">
                  Imported {okEntries.length} of {summary.entries.length} deck
                  {summary.entries.length === 1 ? '' : 's'}.
                </p>
              )}
              {summary.duplicates.length > 0 ? (
                <ul aria-label="Already imported" className="list-disc pl-5 text-sky-300">
                  {summary.duplicates.map((d) => (
                    <li key={d.index}>
                      {d.name}: already imported as &quot;{d.existingName}&quot; (skipped; the
                      existing deck is selected).
                    </li>
                  ))}
                </ul>
              ) : null}
              {warnings.length > 0 ? (
                <ul className="list-disc pl-5 text-amber-300">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              ) : null}
              {failed.length > 0 ? (
                <ul role="alert" className="mt-1 flex flex-col gap-1 text-rose-300">
                  {failed.map((e) => (
                    <li key={e.index}>
                      <span className="font-medium">{e.name} failed:</span>
                      <ul className="list-disc pl-5">
                        {e.errors.map((m, i) => (
                          <li key={i}>{m}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}
