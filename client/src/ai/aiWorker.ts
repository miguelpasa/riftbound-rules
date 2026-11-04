/**
 * Web Worker entry for the AI bot. All logic lives in the pure `handleAiMessage` so it can be unit
 * tested in node; the bottom of the file only wires it to `self.onmessage` when running as a real
 * dedicated worker.
 *
 * Protocol:
 *   -> { type: 'init', deck, seed, seat, cardsJson, budgetMs?, difficulty? }  (cardsJson: JSON string or object)
 *   -> { type: 'decide', requestId, view }
 *   <- { type: 'ready' } | { type: 'decision', requestId, intent | null } | { type: 'error', requestId?, message }
 */
// The engine barrel does not export the AI yet; import the module directly.
import { AIController } from '@riftbound/engine';
import type { CardDatabase, ClientGameState, DeckList, Intent, PlayerId } from '@riftbound/engine';

export interface AiInitMessage {
  type: 'init';
  deck: DeckList;
  seed?: string;
  seat: PlayerId;
  cardsJson: string | CardDatabase;
  budgetMs?: number;
  difficulty?: 'easy' | 'normal';
}
export interface AiDecideMessage {
  type: 'decide';
  requestId: number;
  view: ClientGameState;
}
export type AiRequest = AiInitMessage | AiDecideMessage;

export type AiReply =
  | { type: 'ready' }
  | { type: 'decision'; requestId: number; intent: Intent | null }
  | { type: 'error'; requestId?: number; message: string };

export interface AiWorkerState {
  bot: AIController | null;
}

export const INITIAL_AI_STATE: AiWorkerState = { bot: null };

/** Pure message handler: never throws; failures come back as an 'error' reply. */
export function handleAiMessage(
  state: AiWorkerState,
  msg: AiRequest,
): { state: AiWorkerState; reply: AiReply } {
  try {
    if (msg.type === 'init') {
      const cards: CardDatabase =
        typeof msg.cardsJson === 'string'
          ? (JSON.parse(msg.cardsJson) as CardDatabase)
          : msg.cardsJson;
      const bot = new AIController(msg.seat, {
        cards,
        deck: msg.deck,
        ...(msg.seed !== undefined ? { seed: msg.seed } : {}),
        ...(msg.budgetMs !== undefined ? { budgetMs: msg.budgetMs } : {}),
        ...(msg.difficulty !== undefined ? { difficulty: msg.difficulty } : {}),
      });
      return { state: { bot }, reply: { type: 'ready' } };
    }
    if (msg.type === 'decide') {
      if (!state.bot) {
        return {
          state,
          reply: { type: 'error', requestId: msg.requestId, message: 'bot not initialised' },
        };
      }
      return {
        state,
        reply: { type: 'decision', requestId: msg.requestId, intent: state.bot.decide(msg.view) },
      };
    }
    return { state, reply: { type: 'error', message: 'unknown message' } };
  } catch (e) {
    const requestId = (msg as { requestId?: number }).requestId;
    return {
      state,
      reply: {
        type: 'error',
        ...(requestId !== undefined ? { requestId } : {}),
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

interface WorkerScope {
  onmessage: ((ev: { data: AiRequest }) => void) | null;
  postMessage(msg: AiReply): void;
}

declare const WorkerGlobalScope: unknown;
if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined') {
  const scope = self as unknown as WorkerScope;
  let state: AiWorkerState = INITIAL_AI_STATE;
  scope.onmessage = (ev) => {
    const out = handleAiMessage(state, ev.data);
    state = out.state;
    scope.postMessage(out.reply);
  };
}
