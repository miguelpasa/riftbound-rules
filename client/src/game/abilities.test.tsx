// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TOKEN_CARDS } from '@riftbound/engine';
import type { CardDatabase, CardDef, Intent, PlayerId } from '@riftbound/engine';
import { runEffects } from '../../../engine/src/effects.js';
import { Scenario, SCENARIO_CARDS } from '../../../engine/src/testing/scenario.js';
import { createLocalGameApi, useLocalGameApi, type LocalGame } from '../dev/mockGame';
import { GameProvider } from '../app/gameApi';
import { fakeApi } from '../components/testing/fakeApi';
import { setState } from '../store/gameStore';
import { GameScreen } from './GameScreen';
import { abilityVariants, describeAbility } from './abilities';

afterEach(() => {
  cleanup();
  setState({ toasts: [] });
});

const base = (id: string): CardDef => SCENARIO_CARDS[id] as CardDef;

/** fx-grunt turned into a Fury Gear with the given abilities. */
const gearDb = (abilities: NonNullable<CardDef['abilities']>): CardDatabase => ({
  ...SCENARIO_CARDS,
  ...TOKEN_CARDS,
  'fx-grunt': { ...base('fx-grunt'), type: 'GEAR', stats: {}, abilities },
});

function giveGold(sc: Scenario, player: PlayerId): string {
  const s = structuredClone(sc.state);
  const before = new Set(Object.keys(s.objects));
  runEffects(s, player, [{ op: 'PLAY_TOKEN', token: 'tok-gold', count: 1, ready: true }], sc.cards);
  sc.state = s;
  return Object.keys(s.objects).find((id) => !before.has(id)) as string;
}

function Live({ local }: { local: LocalGame }) {
  return (
    <GameProvider value={useLocalGameApi(local)}>
      <GameScreen />
    </GameProvider>
  );
}

const mountLocal = (sc: Scenario) => {
  const local = createLocalGameApi({ cards: sc.cards, state: sc.state, seat: 'p0' });
  render(<Live local={local} />);
  return local;
};

const SEAL: NonNullable<CardDef['abilities']> = [
  {
    cost: { exhaust: true },
    reaction: true,
    effects: [{ op: 'ADD_POWER', amount: 1, domain: 'SOURCE' }],
  },
  { cost: { energy: 1 }, effects: [{ op: 'DRAW', amount: 1 }] },
];

describe('activated abilities in the UI (R40)', () => {
  it('lists Gold with the gear (not the units) and activates it, filling the Rune Pool', async () => {
    const sc = Scenario.start({}, { ...SCENARIO_CARDS, ...TOKEN_CARDS });
    const gold = giveGold(sc, 'p0');
    mountLocal(sc);

    expect(
      within(screen.getByLabelText('Gear in base')).getByText('Gold token'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Your base')).getByLabelText('Units in base').textContent,
    ).not.toMatch(/Gold token/);
    const btn = screen.getByRole('button', { name: /^Activate Gold token: Exhaust, Kill this/ });
    expect(btn).toHaveAttribute('data-ability', `${gold}:0`);
    expect(screen.getByText('Exhaust, Kill this: Add 1 any-domain Power')).toBeInTheDocument();

    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByTestId('pool-power-any')).toHaveTextContent('Any 1'));
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
    expect(screen.queryByText('Gold token')).toBeNull(); // the token ceased to exist
  });

  it('sends the exact legal ACTIVATE_ABILITY intent', async () => {
    const sc = Scenario.start({}, { ...SCENARIO_CARDS, ...TOKEN_CARDS });
    const gold = giveGold(sc, 'p0');
    const api = fakeApi(sc, 'p0');
    render(
      <GameProvider value={api}>
        <GameScreen />
      </GameProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Activate Gold token/ }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send.mock.calls[0]![0]).toEqual(abilityVariants(api.legal, gold)[0]);
    expect(api.send.mock.calls[0]![0]).toMatchObject({
      type: 'ACTIVATE_ABILITY',
      sourceId: gold,
      abilityIndex: 0,
    });
  });

  it('shows no button for an exhausted source', () => {
    const sc = Scenario.start({}, gearDb([SEAL[0]!]));
    sc.putUnit('p0', 'fx-grunt', 'base', { ready: false });
    sc.setPool('p0', 0);
    mountLocal(sc);
    expect(screen.queryByRole('button', { name: /^Activate/ })).toBeNull();
  });

  it('offers one button per legal ability, with cost and effect text', async () => {
    const sc = Scenario.start({}, gearDb(SEAL));
    sc.giveRunes('p0', 2);
    const g = sc.putUnit('p0', 'fx-grunt', 'base');
    mountLocal(sc);

    const one = screen.getByRole('button', { name: /^Activate 1 .*Exhaust: Add 1 Fury Power/ });
    const two = screen.getByRole('button', { name: /^Activate 2 .*1 Energy: Draw 1/ });
    expect(one).toHaveAttribute('data-ability', `${g}:0`);
    expect(two).toHaveAttribute('data-ability', `${g}:1`);

    // The Chain ability pays automatically, goes on the Chain and is described there.
    fireEvent.click(two);
    const item = await waitFor(() => {
      const el = document.querySelector('[data-chain-item]') as HTMLElement;
      expect(el).not.toBeNull();
      return el;
    });
    expect(item).toHaveTextContent('Cinder Grunt (ability)');
    expect(within(item).getByTestId('chain-ability')).toHaveTextContent('1 Energy: Draw 1');
  });

  it('adds the abilities to the context menu', async () => {
    const sc = Scenario.start({}, gearDb(SEAL));
    sc.giveRunes('p0', 2);
    sc.putUnit('p0', 'fx-grunt', 'base');
    mountLocal(sc);
    const cardEl = document.querySelector('[data-card-id="fx-grunt"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(cardEl);
    });
    const item = await screen.findByRole('menuitem', {
      name: /Activate: Exhaust: Add 1 Fury Power/,
    });
    fireEvent.click(item);
    await waitFor(() => expect(screen.getByTestId('pool-power-Fury')).toHaveTextContent('Fury 1'));
  });

  it('a Legion card shows its discounted cost once another card was played', () => {
    const cards: CardDatabase = {
      ...SCENARIO_CARDS,
      'fx-wisp': { ...base('fx-wisp'), cost: { energy: 3 }, legionCostReduction: 2 },
    };
    const sc = Scenario.start({}, cards);
    sc.giveRunes('p0', 4);
    sc.putInHand('p0', 'fx-wisp');
    const grunt = sc.putInHand('p0', 'fx-grunt');
    const badge = () =>
      within(document.querySelector('[data-card-id="fx-wisp"]') as HTMLElement).getByTestId(
        'cost-energy',
      );
    const first = render(
      <GameProvider value={fakeApi(sc, 'p0')}>
        <GameScreen />
      </GameProvider>,
    );
    expect(badge()).toHaveTextContent('3');
    expect(badge()).not.toHaveAttribute('data-discounted');
    first.unmount();

    sc.play('p0', grunt, {
      payment: sc.exhaustPlan('p0', base('fx-grunt').cost.energy),
      location: { kind: 'base' },
    });
    render(
      <GameProvider value={fakeApi(sc, 'p0')}>
        <GameScreen />
      </GameProvider>,
    );
    expect(badge()).toHaveTextContent('1');
    expect(badge()).toHaveAttribute('data-discounted', 'true');
  });
});

describe('describeAbility', () => {
  it('summarises cost and effect, falling back to the card text', () => {
    const gold = TOKEN_CARDS['tok-gold'] as CardDef;
    const ability = (gold.abilities as NonNullable<CardDef['abilities']>)[0]!;
    expect(describeAbility(gold, ability)).toEqual({
      cost: 'Exhaust, Kill this',
      effect: 'Add 1 any-domain Power',
      summary: 'Exhaust, Kill this: Add 1 any-domain Power',
    });
    const odd = describeAbility(gold, { cost: { energy: 2 }, effects: [{ op: 'KILL_ALL_UNITS' }] });
    expect(odd.summary).toBe('2 Energy: See card text');
  });

  it('abilityVariants keeps only ACTIVATE_ABILITY for the source, in order', () => {
    const mk = (sourceId: string, abilityIndex: number): Intent => ({
      type: 'ACTIVATE_ABILITY',
      playerId: 'p0',
      sourceId,
      abilityIndex,
      payment: [],
    });
    const legal: Intent[] = [
      mk('o1', 1),
      mk('o2', 0),
      mk('o1', 0),
      { type: 'PASS_PRIORITY', playerId: 'p0' },
    ];
    expect(abilityVariants(legal, 'o1').map((v) => v.abilityIndex)).toEqual([0, 1]);
    expect(abilityVariants(legal, 'o3')).toEqual([]);
  });
});
