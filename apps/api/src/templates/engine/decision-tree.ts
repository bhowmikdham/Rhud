/**
 * The decision-tree engine lives in `@rhud/shared` so the web preview can
 * use the exact same code. This module re-exports it for callers under
 * `apps/api/src/templates`.
 */
export {
  resolveNext,
  validateAnswerShape,
  validateTemplate,
  walk,
  type Answer,
  type AnswerMap,
  type ResolveResult,
  type ValidationIssue,
  type WalkStep,
} from '@rhud/shared';
