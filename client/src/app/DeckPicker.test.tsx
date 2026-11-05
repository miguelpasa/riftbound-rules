// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DeckPicker, type DeckChoice } from './DeckPicker';
import {
  deleteImportedDeck,
  listImportedDecks,
  renameImportedDeck,
  saveCustomDeck,
  saveImportedDeck,
  type StorageLike,
} from '../decks/deckStorage';
import { IMPORT_CARDS, IMPORT_DECK_A, IMPORT_DECK_B, shareDeck } from '../decks/importFixtures';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function setup(presets = []) {
  const onChange = vi.fn<(c: DeckChoice | null) => void>();
  render(<DeckPicker presets={presets} cards={IMPORT_CARDS} onChange={onChange} />);
  const last = () => onChange.mock.calls.at(-1)?.[0] ?? null;
  return { onChange, last };
}

function paste(json: unknown) {
  fireEvent.click(screen.getByText('Import deck JSON'));
  fireEvent.change(screen.getByLabelText('Or paste the JSON here'), {
    target: { value: typeof json === 'string' ? json : JSON.stringify(json) },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Import deck' }));
}

describe('deck storage (multi-deck)', () => {
  const mem = (): StorageLike & { map: Map<string, string> } => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    };
  };

  it('saves, lists, renames and deletes decks', () => {
    const s = mem();
    const a = saveImportedDeck({ name: 'A', deck: IMPORT_DECK_A, meta: { placement: '1st' } }, s);
    const b = saveImportedDeck({ name: 'B', deck: IMPORT_DECK_B }, s);
    expect(a.id).not.toBe(b.id);
    expect(listImportedDecks(s).map((d) => d.name)).toEqual(['A', 'B']);
    expect(listImportedDecks(s)[0]!.meta.placement).toBe('1st');
    expect(renameImportedDeck(b.id, '  Renamed ', s)).toBe(true);
    expect(renameImportedDeck(b.id, '   ', s)).toBe(false);
    expect(renameImportedDeck('nope', 'x', s)).toBe(false);
    expect(deleteImportedDeck(a.id, s)).toBe(true);
    expect(deleteImportedDeck(a.id, s)).toBe(false);
    expect(listImportedDecks(s).map((d) => d.name)).toEqual(['Renamed']);
  });

  it('migrates the legacy single custom deck once', () => {
    const s = mem();
    saveCustomDeck(IMPORT_DECK_A, s);
    const first = listImportedDecks(s);
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toBe('custom');
    expect(s.map.has('riftbound.customDeck')).toBe(false);
    expect(listImportedDecks(s)).toHaveLength(1);
  });

  it('survives corrupt stored data', () => {
    const s = mem();
    s.setItem('riftbound.importedDecks', '{oops');
    expect(listImportedDecks(s)).toEqual([]);
    s.setItem('riftbound.importedDecks', JSON.stringify([{ id: 1 }, 5, null]));
    expect(listImportedDecks(s)).toEqual([]);
  });
});

describe('DeckPicker import', () => {
  it('imports a list of decks, selects the first and persists them', () => {
    const { last } = setup();
    paste([
      shareDeck(IMPORT_DECK_A, 'Deck A', { eventName: 'Cup', placement: '1st place' }),
      shareDeck(IMPORT_DECK_B, 'Deck B'),
    ]);
    const group = screen.getByRole('radiogroup', { name: 'Decks' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Deck A', 'Deck B']);
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(radios[0]!).getByText('Cup - 1st place')).toBeInTheDocument();
    expect(within(radios[0]!).getByText(/Ember/)).toBeInTheDocument();
    expect(within(radios[0]!).getByText(/\d+\/\d+ cards fully implemented/)).toBeInTheDocument();
    expect(screen.getByRole('status', { name: 'Import result' })).toHaveTextContent(
      'Imported 2 of 2 decks.',
    );
    expect(last()?.name).toBe('Deck A');
    expect(listImportedDecks()).toHaveLength(2);
  });

  it('shows the partial-support badge for decks with partial cards', () => {
    setup();
    paste(shareDeck(IMPORT_DECK_A, 'Deck A'));
    const radio = screen.getByRole('radio', { name: 'Deck A' });
    const partial = IMPORT_DECK_A.mainDeck
      .concat(IMPORT_DECK_A.championId)
      .filter((id) => IMPORT_CARDS[id]!.supportLevel !== 'full').length;
    if (partial > 0) expect(within(radio).getByRole('img')).toBeInTheDocument();
    else expect(within(radio).queryByRole('img')).toBeNull();
  });

  it('imports valid decks and lists the errors of failed ones', () => {
    setup();
    const bad = shareDeck(IMPORT_DECK_A, 'Broken');
    bad.cards.push({ code: 'ZZZ-123', qty: 1, zone: 'MAIN', name: 'Ghost' });
    paste({ decks: [bad, shareDeck(IMPORT_DECK_B, 'Good')] });
    expect(screen.getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['Good']);
    const status = screen.getByRole('status', { name: 'Import result' });
    expect(status).toHaveTextContent('Imported 1 of 2 decks.');
    expect(status).toHaveTextContent('Broken failed:');
    expect(status).toHaveTextContent('Unknown card ZZZ-123');
  });

  it('shows a fatal error for invalid JSON and imports nothing', () => {
    setup();
    paste('{not json');
    expect(screen.getByRole('alert')).toHaveTextContent(/Invalid JSON/);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
  });

  it('imports from a chosen file', async () => {
    setup();
    fireEvent.click(screen.getByText('Import deck JSON'));
    const file = new File([JSON.stringify(shareDeck(IMPORT_DECK_A, 'From file'))], 'd.json', {
      type: 'application/json',
    });
    // jsdom's File lacks text() in some versions
    if (typeof file.text !== 'function') {
      Object.defineProperty(file, 'text', {
        value: () => Promise.resolve(JSON.stringify(shareDeck(IMPORT_DECK_A, 'From file'))),
      });
    }
    fireEvent.change(screen.getByLabelText(/Load a JSON file/), { target: { files: [file] } });
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: 'From file' })).toBeInTheDocument(),
    );
  });

  it('keeps the old single custom deck selectable (migration)', () => {
    saveCustomDeck(IMPORT_DECK_B);
    localStorage.setItem('riftbound.selectedDeckId', 'custom');
    const { last } = setup();
    expect(screen.getByRole('radio', { name: 'Imported deck' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(last()?.id).toBe('custom');
  });
});

describe('DeckPicker manage', () => {
  it('renames and deletes an imported deck, falling back to another selection', () => {
    saveImportedDeck({ name: 'One', deck: IMPORT_DECK_A });
    saveImportedDeck({ name: 'Two', deck: IMPORT_DECK_B });
    const { last } = setup();
    expect(last()?.name).toBe('One');

    fireEvent.click(screen.getByRole('button', { name: 'Rename One' }));
    const input = screen.getByLabelText('Deck name');
    fireEvent.change(input, { target: { value: 'Uno' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('radio', { name: 'Uno' })).toBeInTheDocument();
    expect(listImportedDecks()[0]!.name).toBe('Uno');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Uno' }));
    expect(screen.queryByRole('radio', { name: 'Uno' })).toBeNull();
    expect(listImportedDecks().map((d) => d.name)).toEqual(['Two']);
    expect(last()?.name).toBe('Two');
  });

  it('selects by click and remembers the choice', () => {
    saveImportedDeck({ name: 'One', deck: IMPORT_DECK_A });
    saveImportedDeck({ name: 'Two', deck: IMPORT_DECK_B });
    const { last } = setup();
    fireEvent.click(screen.getByRole('radio', { name: 'Two' }));
    expect(last()?.name).toBe('Two');
    cleanup();
    const again = setup();
    expect(again.last()?.name).toBe('Two');
  });

  it('flags a stored deck that no longer validates and does not choose it', () => {
    saveImportedDeck({ name: 'Stale', deck: { ...IMPORT_DECK_A, mainDeck: ['tst-999-100'] } });
    const { last } = setup();
    expect(screen.getByRole('radio', { name: 'Stale' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Not valid with the current card data')).toBeInTheDocument();
    expect(last()).toBeNull();
  });
});

describe('DeckPicker duplicates and coverage warning', () => {
  it('skips an identical deck imported a second time and says so', () => {
    setup();
    paste(shareDeck(IMPORT_DECK_A, 'Deck A'));
    expect(listImportedDecks()).toHaveLength(1);
    paste(shareDeck(IMPORT_DECK_A, 'Deck A again'));
    expect(listImportedDecks()).toHaveLength(1);
    const status = screen.getByRole('status', { name: 'Import result' });
    expect(status).toHaveTextContent('Imported 0 of 1 deck.');
    expect(status).toHaveTextContent('already imported as "Deck A"');
    expect(screen.getAllByRole('radio')).toHaveLength(1);
  });

  it('skips duplicates inside one file but imports the distinct ones', () => {
    setup();
    paste([
      shareDeck(IMPORT_DECK_A, 'Deck A'),
      shareDeck(IMPORT_DECK_A, 'Copy of A'),
      shareDeck(IMPORT_DECK_B, 'Deck B'),
    ]);
    expect(listImportedDecks().map((d) => d.name)).toEqual(['Deck A', 'Deck B']);
    expect(screen.getByRole('status', { name: 'Import result' })).toHaveTextContent(
      'Imported 2 of 3 decks.',
    );
  });

  it('warns without blocking when under 60% of the selected deck is implemented', () => {
    const cards = Object.fromEntries(
      Object.entries(IMPORT_CARDS).map(([k, c]) => [k, { ...c, supportLevel: 'partial' as const }]),
    );
    const onChange = vi.fn<(c: DeckChoice | null) => void>();
    render(<DeckPicker presets={[]} cards={cards} onChange={onChange} />);
    paste(shareDeck(IMPORT_DECK_A, 'Deck A'));
    expect(screen.getByRole('status', { name: 'Deck coverage warning' })).toHaveTextContent(
      'Many cards in this deck have no effect yet',
    );
    expect(onChange.mock.calls.at(-1)?.[0]?.name).toBe('Deck A');
  });

  it('shows no coverage warning for a fully implemented deck', () => {
    const cards = Object.fromEntries(
      Object.entries(IMPORT_CARDS).map(([k, c]) => [k, { ...c, supportLevel: 'full' as const }]),
    );
    render(<DeckPicker presets={[]} cards={cards} onChange={vi.fn()} />);
    paste(shareDeck(IMPORT_DECK_A, 'Deck A'));
    expect(screen.queryByRole('status', { name: 'Deck coverage warning' })).toBeNull();
  });

  it('gives Rename and Delete a 44px minimum hit area on narrow screens', () => {
    setup();
    paste(shareDeck(IMPORT_DECK_A, 'Deck A'));
    for (const name of ['Rename Deck A', 'Delete Deck A']) {
      expect(screen.getByRole('button', { name }).className).toContain('min-h-11');
    }
  });
});
