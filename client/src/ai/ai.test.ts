import { describe, expect, it } from 'vitest';
import { actorToAct, createGame, reduce, sanitizeFor, type Intent } from '@riftbound/engine';
import {
  FIXTURE_CARDS,
  FIXTURE_DECK_A,
  FIXTURE_DECK_B,
} from '../../../engine/src/testing/fixtures.js';
import { createAiBot, type WorkerLike } from './aiClient.js';
import { handleAiMessage, INITIAL_AI_STATE, type AiReply, type AiRequest } from './aiWorker.js';

function setup() {
  const state = createGame(FIXTURE_CARDS, [FIXTURE_DECK_A, FIXTURE_DECK_B], 'client-ai');
  const seat = actorToAct(state);
  const legend = state.objects[state.players[seat === 'p0' ? 0 : 1].legend as string]?.cardId;
  const deck = legend === FIXTURE_DECK_A.legendId ? FIXTURE_DECK_A : FIXTURE_DECK_B;
  return { state, seat, deck, view: sanitizeFor(state, seat) };
}

// Tests: handleAiMessage is a pure init/decide state machine.
describe('handleAiMessage', () => {
  it('initialises, then answers a decide request with a legal intent', () => {
    const { state, seat, deck, view } = setup();
    const init = handleAiMessage(INITIAL_AI_STATE, {
      type: 'init',
      deck,
      seat,
      seed: 'w',
      cardsJson: JSON.stringify(FIXTURE_CARDS),
    });
    expect(init.reply).toEqual({ type: 'ready' });
    const out = handleAiMessage(init.state, { type: 'decide', requestId: 7, view });
    expect(out.reply.type).toBe('decision');
    if (out.reply.type !== 'decision') return;
    expect(out.reply.requestId).toBe(7);
    expect(out.reply.intent).not.toBeNull();
    expect(reduce(state, FIXTURE_CARDS, out.reply.intent as Intent).ok).toBe(true);
  });

  it('reports an error for decide-before-init and for bad card json, without throwing', () => {
    const { seat, deck, view } = setup();
    expect(handleAiMessage(INITIAL_AI_STATE, { type: 'decide', requestId: 1, view }).reply).toEqual(
      { type: 'error', requestId: 1, message: 'bot not initialised' },
    );
    const bad = handleAiMessage(INITIAL_AI_STATE, {
      type: 'init',
      deck,
      seat,
      cardsJson: '{not json',
    });
    expect(bad.reply.type).toBe('error');
    expect(bad.state).toBe(INITIAL_AI_STATE);
  });
});

// Tests: the inline path of createAiBot (no Worker available).
describe('createAiBot inline', () => {
  it('returns a promise of a legal intent and null when it is not the bot turn', async () => {
    const { state, seat, deck, view } = setup();
    const bot = createAiBot({ cards: FIXTURE_CARDS, deck, seat, seed: 'i', workerFactory: null });
    const p = bot.decide(view);
    expect(p).toBeInstanceOf(Promise);
    const intent = await p;
    expect(intent).not.toBeNull();
    expect(reduce(state, FIXTURE_CARDS, intent as Intent).ok).toBe(true);

    const other = seat === 'p0' ? 'p1' : 'p0';
    const idle = createAiBot({
      cards: FIXTURE_CARDS,
      deck,
      seat: other,
      workerFactory: null,
    });
    expect(await idle.decide(sanitizeFor(state, other))).toBeNull();
    bot.dispose();
  });
});

/** A fake Worker that runs handleAiMessage on the "other side" of postMessage. */
function fakeWorker(opts: { silent?: boolean } = {}): {
  make: () => WorkerLike;
  sent: AiRequest[];
} {
  const sent: AiRequest[] = [];
  const make = (): WorkerLike => {
    let st = INITIAL_AI_STATE;
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      terminate: () => undefined,
      postMessage: (msg) => {
        sent.push(msg);
        if (opts.silent) return;
        const out = handleAiMessage(st, msg);
        st = out.state;
        const reply: AiReply = out.reply;
        queueMicrotask(() => w.onmessage?.({ data: reply }));
      },
    };
    return w;
  };
  return { make, sent };
}

// Tests: the worker path of createAiBot (init once, request ids, timeout fallback).
describe('createAiBot worker path', () => {
  it('sends init once and resolves decisions from worker replies', async () => {
    const { state, seat, deck, view } = setup();
    const fw = fakeWorker();
    const bot = createAiBot({ cards: FIXTURE_CARDS, deck, seat, workerFactory: fw.make });
    const a = await bot.decide(view);
    const b = await bot.decide(view);
    expect(a).toEqual(b);
    expect(reduce(state, FIXTURE_CARDS, a as Intent).ok).toBe(true);
    expect(fw.sent.filter((m) => m.type === 'init')).toHaveLength(1);
    expect(fw.sent.filter((m) => m.type === 'decide')).toHaveLength(2);
    bot.dispose();
    expect(await bot.decide(view)).toBeNull();
  });

  it('falls back to null when the worker never answers', async () => {
    const { seat, deck, view } = setup();
    const fw = fakeWorker({ silent: true });
    const bot = createAiBot({
      cards: FIXTURE_CARDS,
      deck,
      seat,
      timeoutMs: 20,
      workerFactory: fw.make,
    });
    expect(await bot.decide(view)).toBeNull();
    bot.dispose();
  });

  it('falls back to null when the worker factory throws', async () => {
    const { seat, deck, view } = setup();
    const bot = createAiBot({
      cards: FIXTURE_CARDS,
      deck,
      seat,
      workerFactory: () => {
        throw new Error('no worker');
      },
    });
    expect(await bot.decide(view)).toBeNull();
  });

  it('restarts a worker that errored and still answers the next decision', async () => {
    // Tests Rule 117: the host always gets an answer (null -> legal fallback), never waits forever
    const { state, seat, deck, view } = setup();
    const made: ReturnType<typeof fakeWorker>[] = [];
    let terminated = 0;
    const bot = createAiBot({
      cards: FIXTURE_CARDS,
      deck,
      seat,
      timeoutMs: 1000,
      workerFactory: () => {
        const fw = fakeWorker();
        made.push(fw);
        const w = fw.make();
        const post = w.postMessage;
        let first = made.length === 1;
        w.terminate = () => {
          terminated++;
        };
        w.postMessage = (msg) => {
          if (first && msg.type === 'decide') {
            first = false;
            queueMicrotask(() => w.onerror?.(new Error('crashed')));
            return;
          }
          post(msg);
        };
        return w;
      },
    });
    const t0 = Date.now();
    expect(await bot.decide(view)).toBeNull(); // settled by onerror, not by the 1000 ms timeout
    expect(Date.now() - t0).toBeLessThan(500);
    expect(terminated).toBe(1);
    const next = await bot.decide(view);
    expect(made).toHaveLength(2);
    expect(reduce(state, FIXTURE_CARDS, next as Intent).ok).toBe(true);
    bot.dispose();
  });

  it('terminates a worker that times out so the next decision gets a fresh one', async () => {
    // Tests Rule 117: a wedged worker cannot block the game
    const { seat, deck, view } = setup();
    let terminated = 0;
    let made = 0;
    const bot = createAiBot({
      cards: FIXTURE_CARDS,
      deck,
      seat,
      timeoutMs: 20,
      workerFactory: () => {
        made++;
        const w = fakeWorker({ silent: true }).make();
        w.terminate = () => {
          terminated++;
        };
        return w;
      },
    });
    expect(await bot.decide(view)).toBeNull();
    expect(await bot.decide(view)).toBeNull();
    expect(made).toBe(2);
    expect(terminated).toBeGreaterThanOrEqual(2);
    bot.dispose();
  });
});
