// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { autoAssign } from '@riftbound/engine';
import { GameProvider } from '../app/gameApi';
import { CombatDialog } from './CombatDialog';
import { combatShowdown, damageScenario } from './testing/combatScenario';
import { fakeApi, type FakeApi } from './testing/fakeApi';

afterEach(cleanup);

function mount(api: FakeApi) {
  return render(
    <GameProvider value={api}>
      <CombatDialog />
    </GameProvider>,
  );
}

const ATT = ['fx-ash-tank', 'fx-grunt'];
const DEF = ['fx-order-tank', 'fx-tide-grunt', 'fx-tide-archer'];

const row = (id: string) => document.querySelector(`[data-unit-id="${id}"]`) as HTMLElement;
const click = (name: string | RegExp, within_?: HTMLElement) =>
  fireEvent.click((within_ ? within(within_) : screen).getByRole('button', { name }));

describe('CombatDialog: Showdown banner', () => {
  it('names the battlefield, attacker, defender and Focus', () => {
    const { sc } = combatShowdown(['fx-ash-tank'], ['fx-order-tank']);
    mount(fakeApi(sc, 'p0'));
    const banner = screen.getByTestId('showdown-banner');
    expect(banner).toHaveTextContent(
      /Showdown at Test Battlefield \d: Attacker You, Defender Opponent; Focus: You/,
    );
    expect(banner).toHaveTextContent('Only Action and Reaction');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('reads from the opponent perspective', () => {
    const { sc } = combatShowdown(['fx-ash-tank'], ['fx-order-tank']);
    mount(fakeApi(sc, 'p1'));
    expect(screen.getByTestId('showdown-banner')).toHaveTextContent(
      /Attacker Opponent, Defender You; Focus: Opponent/,
    );
  });

  it('renders nothing in plain play', () => {
    const { sc } = combatShowdown(['fx-ash-tank'], ['fx-order-tank']);
    sc.pass('p0');
    sc.pass('p1');
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: autoAssign(sc.state, sc.cards, 'p0'),
    });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: autoAssign(sc.state, sc.cards, 'p1'),
    });
    const { container } = mount(fakeApi(sc, 'p0'));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('CombatDialog: damage assignment', () => {
  it('lists enemy units Tank first and Backline last, with my total Might', () => {
    const { sc, def } = damageScenario(ATT, DEF);
    mount(fakeApi(sc, 'p0'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('damage-total')).toHaveTextContent('5');
    const rows = within(screen.getByRole('list', { name: 'Enemy units' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-unit-id'))).toEqual([def[0], def[1], def[2]]);
    expect(rows[0]).toHaveTextContent('Order Warden');
    expect(rows[0]).toHaveTextContent('Tank');
    expect(rows[2]).toHaveTextContent('Backline');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('puts a Tank that is the newest unit first', () => {
    const { sc, def } = damageScenario(['fx-grunt'], ['fx-tide-grunt', 'fx-order-tank']);
    mount(fakeApi(sc, 'p0'));
    const rows = within(screen.getByRole('list', { name: 'Enemy units' })).getAllByRole('listitem');
    expect(rows.map((r) => r.getAttribute('data-unit-id'))).toEqual([def[1], def[0]]);
  });

  it('shows Assault in the total Might', () => {
    const { sc } = damageScenario(['fx-raider'], ['fx-order-tank']);
    mount(fakeApi(sc, 'p0'));
    expect(screen.getByTestId('damage-total')).toHaveTextContent('3'); // 2 + Assault 1
  });

  it('blocks a distribution that skips the Tank and names the rule', () => {
    const { sc, def } = damageScenario(ATT, DEF);
    mount(fakeApi(sc, 'p0'));
    const [tank, grunt, archer] = def as [string, string, string];
    // grunt 2 + archer 2 + tank 1 = 5
    click(/Lethal to Tide Scholar/);
    click(/Lethal to Tide Lookout/);
    click(/Add damage to Order Warden/);
    expect(screen.getByTestId('damage-validation')).toHaveTextContent(
      'Order Warden (Tank) must be assigned lethal damage before Tide Scholar (Normal)',
    );
    expect(screen.getByTestId('damage-validation')).toHaveTextContent('Rule 467.2.c');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(row(tank)).toBeTruthy();
    expect(row(grunt)).toBeTruthy();
    expect(row(archer)).toBeTruthy();
  });

  it('blocks a total that differs from my Might', () => {
    const { sc } = damageScenario(ATT, DEF);
    mount(fakeApi(sc, 'p0'));
    click(/Lethal to Order Warden/);
    expect(screen.getByTestId('damage-status')).toHaveTextContent('3 / 5 assigned');
    expect(screen.getByTestId('damage-validation')).toHaveTextContent(
      'Assign exactly 5 damage (currently 3)',
    );
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('stops adding past my total', () => {
    const { sc } = damageScenario(ATT, DEF);
    mount(fakeApi(sc, 'p0'));
    click(/Lethal to Order Warden/);
    click(/Lethal to Tide Scholar/);
    expect(screen.getByTestId('damage-status')).toHaveTextContent('5 / 5 assigned');
    for (const b of screen.getAllByRole('button', { name: /Add damage to/ }))
      expect(b).toBeDisabled();
  });

  it('Confirm sends the exact ASSIGN_COMBAT_DAMAGE', async () => {
    const { sc, def } = damageScenario(ATT, DEF);
    const api = fakeApi(sc, 'p0');
    mount(api);
    click(/Lethal to Order Warden/);
    click(/Lethal to Tide Scholar/);
    expect(screen.queryByTestId('damage-validation')).toBeNull();
    click('Confirm');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [
        { unitId: def[0], amount: 3 },
        { unitId: def[1], amount: 2 },
      ],
    });
    await expect(api.send.mock.results[0]!.value).resolves.toEqual({ ok: true });
  });

  it('steppers: +/- adjust one unit; Confirm sends what the steppers show', async () => {
    const { sc, def } = damageScenario(
      ['fx-ash-tank', 'fx-grunt'],
      ['fx-order-tank', 'fx-tide-grunt'],
    );
    const api = fakeApi(sc, 'p0');
    mount(api);
    const plus = (n: string) =>
      screen.getByRole('button', { name: new RegExp(`Add damage to ${n}`) });
    const minus = (n: string) =>
      screen.getByRole('button', { name: new RegExp(`Remove damage from ${n}`) });
    expect(minus('Order Warden')).toBeDisabled();
    fireEvent.click(plus('Tide Scholar'));
    expect(screen.getByTestId('damage-validation')).toBeInTheDocument(); // total 1/5
    fireEvent.click(minus('Tide Scholar'));
    for (let i = 0; i < 3; i++) fireEvent.click(plus('Order Warden'));
    for (let i = 0; i < 2; i++) fireEvent.click(plus('Tide Scholar'));
    expect(screen.getByLabelText(/Damage to Order Warden/)).toHaveTextContent('3');
    expect(screen.getByLabelText(/Damage to Tide Scholar/)).toHaveTextContent('2');
    expect(screen.getByTestId('damage-status')).toHaveTextContent('5 / 5 assigned');
    expect(screen.queryByTestId('damage-validation')).toBeNull();
    click('Confirm');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(api.send).toHaveBeenCalledWith({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: [
        { unitId: def[0], amount: 3 },
        { unitId: def[1], amount: 2 },
      ],
    });
  });

  it('rejects surplus on a non-last unit while another lacks lethal (Rule 467.2.c.4)', () => {
    const { sc } = damageScenario(['fx-ash-tank', 'fx-grunt'], ['fx-order-tank', 'fx-tide-grunt']);
    mount(fakeApi(sc, 'p0'));
    for (let i = 0; i < 5; i++) {
      fireEvent.click(screen.getByRole('button', { name: /Add damage to Order Warden/ }));
    }
    expect(screen.getByTestId('damage-validation')).toHaveTextContent('467.2.c.4');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  });

  it('Auto assign fills in the legal ASSIGN_COMBAT_DAMAGE from api.legal, then Confirm sends it', async () => {
    const { sc } = damageScenario(ATT, DEF);
    const api = fakeApi(sc, 'p0');
    const legalAssign = api.legal.filter((i) => i.type === 'ASSIGN_COMBAT_DAMAGE');
    expect(legalAssign.length).toBeGreaterThan(0);
    mount(api);
    click('Auto assign');
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeEnabled();
    click('Confirm');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    const sent = api.send.mock.calls[0]![0];
    expect(api.legal).toContainEqual(sent);
    expect(sent).toEqual(legalAssign[0]);
    await expect(api.send.mock.results[0]!.value).resolves.toEqual({ ok: true });
  });

  it('Auto assign uses the first legal variant even when it is not the only one', () => {
    const { sc } = damageScenario(['fx-titan'], ['fx-order-tank', 'fx-tide-grunt']); // 5 vs lethal 3 + 2
    const api = fakeApi(sc, 'p0');
    // Keep only the variant list as the engine offers; the first is the engine's autoAssign.
    const first = api.legal.find((i) => i.type === 'ASSIGN_COMBAT_DAMAGE');
    expect(first).toMatchObject({ assignments: autoAssign(sc.state, sc.cards, 'p0') });
    mount(api);
    click('Auto assign');
    for (const a of (first as { assignments: { unitId: string; amount: number }[] }).assignments) {
      expect(within(row(a.unitId)).getByLabelText(/Damage to/)).toHaveTextContent(String(a.amount));
    }
  });

  it('shows an engine rejection inline', async () => {
    const { sc } = damageScenario(ATT, DEF);
    const api = fakeApi(sc, 'p0', {
      sendResult: {
        ok: false,
        code: 'INVALID_DAMAGE_ASSIGNMENT',
        message: '[Rule Error] bad split',
      },
    });
    mount(api);
    click('Auto assign');
    click('Confirm');
    expect(await screen.findByRole('alert')).toHaveTextContent('[Rule Error] bad split');
  });

  it('shows a waiting message (no dialog) while the opponent assigns', () => {
    const { sc } = damageScenario(ATT, DEF);
    mount(fakeApi(sc, 'p1'));
    expect(screen.getByText('Opponent is assigning damage...')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the second assigner gets the dialog after the first has assigned', () => {
    const { sc } = damageScenario(ATT, DEF);
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: autoAssign(sc.state, sc.cards, 'p0'),
    });
    expect(sc.state.flow.combat?.awaitingAssignmentFrom).toBe('p1');
    mount(fakeApi(sc, 'p1'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const rows = within(screen.getByRole('list', { name: 'Enemy units' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Ash Bulwark'); // p0's Tank first
  });
});

describe('CombatDialog: result summary', () => {
  function resolved() {
    const { sc, def } = damageScenario(['fx-ash-tank'], ['fx-order-tank']);
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: autoAssign(sc.state, sc.cards, 'p0'),
    });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: autoAssign(sc.state, sc.cards, 'p1'),
    });
    return { sc, def };
  }

  it('summarises damage and kills from recentEvents and can be dismissed', () => {
    const { sc } = resolved();
    expect(sc.state.flow.combat).toBeUndefined();
    mount(fakeApi(sc, 'p0', { events: sc.events }));
    const panel = screen.getByTestId('combat-result');
    expect(panel).toHaveTextContent('You dealt 3 damage to Order Warden');
    expect(panel).toHaveTextContent('Opponent dealt 3 damage to Ash Bulwark');
    expect(panel).toHaveTextContent('Killed: Ash Bulwark, Order Warden');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss combat result' }));
    expect(screen.queryByTestId('combat-result')).toBeNull();
  });

  it('mentions points and control changes when they happened', () => {
    const { sc } = damageScenario(['fx-ash-tank', 'fx-grunt'], ['fx-tide-grunt']);
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p0',
      assignments: autoAssign(sc.state, sc.cards, 'p0'),
    });
    sc.do({
      type: 'ASSIGN_COMBAT_DAMAGE',
      playerId: 'p1',
      assignments: autoAssign(sc.state, sc.cards, 'p1'),
    });
    mount(fakeApi(sc, 'p0', { events: sc.events }));
    const panel = screen.getByTestId('combat-result');
    expect(panel).toHaveTextContent('You now control');
    expect(panel).toHaveTextContent('You gained 1 point (conquer)');
  });

  it('is absent without combat damage events', () => {
    const { sc } = combatShowdown(['fx-ash-tank'], ['fx-order-tank']);
    mount(fakeApi(sc, 'p0', { events: sc.events }));
    expect(screen.queryByTestId('combat-result')).toBeNull();
  });
});
