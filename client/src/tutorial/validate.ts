import { buildLessonState } from './sandbox';
import type { LessonDef } from './types';

/** Known static tutorial id prefixes/names (see AUTHORING.md). */
const STATIC_IDS = new Set([
  'hand',
  'base',
  'opp-base',
  'score',
  'phase-tracker',
  'rune-panel',
  'chain-panel',
  'btn-pass',
  'btn-end-turn',
]);
const PREFIXES = ['hand-card:', 'unit:', 'opp-unit:', 'battlefield:'];

export function isKnownTutorialId(id: string): boolean {
  return /^[[.#]/.test(id) || STATIC_IDS.has(id) || PREFIXES.some((p) => id.startsWith(p));
}

/** Static checks for a lesson file; returns human-readable problems (empty = fine). */
export function validateLesson(lesson: LessonDef): string[] {
  const bad: string[] = [];
  if (!lesson.id) bad.push('missing id');
  if (!lesson.title) bad.push('missing title');
  if (lesson.comingSoon) return bad;
  if (lesson.steps.length === 0) bad.push('no steps');
  if (lesson.concept.length === 0) bad.push('no concept paragraphs');
  if (!lesson.completionText) bad.push('missing completionText');
  const seen = new Set<string>();
  for (const s of lesson.steps) {
    if (seen.has(s.id)) bad.push(`duplicate step id ${s.id}`);
    seen.add(s.id);
    if (!s.title || !s.instruction) bad.push(`step ${s.id}: title/instruction required`);
    if (Array.isArray(s.highlight)) {
      for (const h of s.highlight) {
        if (!isKnownTutorialId(h)) bad.push(`step ${s.id}: unknown highlight id "${h}"`);
      }
    }
  }
  try {
    buildLessonState(lesson);
  } catch (e) {
    bad.push(`setup failed: ${String(e)}`);
  }
  return bad;
}
