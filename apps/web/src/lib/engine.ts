/**
 * Re-export of the pure decision-tree engine for the web client.
 * The implementation lives in @rhud/shared (used by both api and web).
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
