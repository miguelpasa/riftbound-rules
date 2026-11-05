import type { LessonDef } from '../types';
import { LESSON_0_DEMO } from './lesson0-demo';
import { LESSON_1 } from './lesson1';
import { LESSON_2 } from './lesson2';
import { LESSON_3 } from './lesson3';
import { LESSON_4 } from './lesson4';
import { LESSON_5 } from './lesson5';
import { LESSON_6 } from './lesson6';

/**
 * The ordered lesson list. Add a lesson by creating its file and listing it here.
 * Lessons with `comingSoon: true` are shown disabled.
 */
export const LESSONS: LessonDef[] = [
  LESSON_0_DEMO,
  LESSON_1,
  LESSON_2,
  LESSON_3,
  LESSON_4,
  LESSON_5,
  LESSON_6,
];
