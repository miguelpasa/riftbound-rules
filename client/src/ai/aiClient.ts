/**
 * Client-side AI bot factory. `createAiBot` returns a BotLike (decide() -> Promise). In a browser it
 * runs the AIController in a module Web Worker so the UI thread never blocks; without Worker support
 * (node, tests, old browsers) it runs the same controller inline.
 *
 * Worker failures never wedge the game: a decide() that is not answered within `timeoutMs` (default
 * 5000) resolves to null and the host falls back to its own default action.
 */
import { AIController } from '@riftbound/engine';
import type { CardDatabase, ClientGameState, DeckList, Intent, PlayerId } from '@riftbound/engine';
import type { AiReply, AiRequest } from './aiWorker.js';

export interface BotLike {
  decide(view: ClientGameState): Intent | null | Promise<Intent | null>;
}

export interface AiBot extends BotLike {
  decide(view: ClientGameState): Promise<Intent | null>;
  /** Terminate the worker (no-op for the inline bot). */
  dispose(): void;
}

/** The slice of the Worker API the client uses (so tests can inject a fake). */
export interface WorkerLike {
  postMessage(msg: AiRequest): void;
  terminate(): void;
  onmessage: ((ev: { data: AiReply }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface CreateAiBotOptions {
  cards: CardDatabase;
  deck: DeckList;
  seat: PlayerId;
  seed?: string;
  budgetMs?: number;
  difficulty?: 'easy' | 'normal';
  /** Per-decision timeout in the worker path (default 5000 ms). */
  timeoutMs?: number;
  /** `null` = force inline, a function = custom worker. Default: a real Worker when available. */
  workerFactory?: (() => WorkerLike) | null;
}

function defaultWorkerFactory(): (() => WorkerLike) | null {
  if (typeof Worker === 'undefined') return null;
  return () =>
    new Worker(new URL('./aiWorker.ts', import.meta.url), {
      type: 'module',
    }) as unknown as WorkerLike;
}

export function createAiBot(opts: CreateAiBotOptions): AiBot {
  const factory = opts.workerFactory === undefined ? defaultWorkerFactory() : opts.workerFactory;
  if (factory === null) return createInlineBot(opts);
  return createWorkerBot(opts, factory);
}

function createInlineBot(opts: CreateAiBotOptions): AiBot {
  const controller = new AIController(opts.seat, {
    cards: opts.cards,
    deck: opts.deck,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
    ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
  });
  return {
    decide: (view) => {
      try {
        return Promise.resolve(controller.decide(view));
      } catch {
        return Promise.resolve(null);
      }
    },
    dispose: () => undefined,
  };
}

function createWorkerBot(opts: CreateAiBotOptions, factory: () => WorkerLike): AiBot {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pending = new Map<number, (intent: Intent | null) => void>();
  let nextId = 1;
  let worker: WorkerLike | null = null;
  let disposed = false;

  const settleAll = (): void => {
    for (const resolve of [...pending.values()]) resolve(null);
    pending.clear();
  };

  /** Drop a dead / stuck worker: the next decide() spawns and re-initialises a fresh one. */
  const discardWorker = (): void => {
    const w = worker;
    worker = null;
    settleAll();
    try {
      w?.terminate();
    } catch {
      /* already gone */
    }
  };

  const start = (): WorkerLike => {
    const w = factory();
    w.onmessage = (ev) => {
      const r = ev.data;
      if (r.type === 'decision') pending.get(r.requestId)?.(r.intent);
      else if (r.type === 'error' && r.requestId !== undefined) pending.get(r.requestId)?.(null);
    };
    w.onerror = () => {
      if (worker === w) discardWorker();
    };
    const init: AiRequest = {
      type: 'init',
      deck: opts.deck,
      seat: opts.seat,
      cardsJson: JSON.stringify(opts.cards),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
      ...(opts.budgetMs !== undefined ? { budgetMs: opts.budgetMs } : {}),
      ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
    };
    w.postMessage(init);
    return w;
  };

  return {
    decide: (view) =>
      new Promise<Intent | null>((resolve) => {
        if (disposed) return resolve(null);
        let w: WorkerLike;
        try {
          w = worker ??= start();
        } catch {
          return resolve(null);
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
          // An unanswered worker is considered wedged (a long search keeps it busy): restart it.
          if (worker === w) discardWorker();
        }, timeoutMs);
        pending.set(id, (intent) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(intent);
        });
        try {
          w.postMessage({ type: 'decide', requestId: id, view });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          resolve(null);
        }
      }),
    dispose: () => {
      disposed = true;
      settleAll();
      worker?.terminate();
      worker = null;
    },
  };
}
