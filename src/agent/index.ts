/**
 * THE SEAM.
 *
 * These are the only two functions Kaustubh calls. Both are frozen per §4:
 *
 *   analyze(bundle: EvidenceBundle): Promise<PermissionAnalysis>
 *   adjudicate(report: ShadowReport): Promise<ReadinessVerdict>
 *
 * Both return a schema-valid typed object or throw a typed error. Never partial
 * garbage, never a silently-degraded result.
 *
 * Only ANTHROPIC_API_KEY is required, read from .env at the repo root.
 */

export { analyze } from './analyst.js';

export {
  AgentRefusalError,
  AgentSchemaError,
  AgentTimeoutError,
  AgentConfigError,
} from './errors.js';

export type {
  EvidenceBundle,
  PermissionAnalysis,
  ShadowReport,
  ReadinessVerdict,
} from './types.js';

export {
  EvidenceBundleSchema,
  PermissionAnalysisSchema,
  ShadowReportSchema,
  ReadinessVerdictSchema,
} from './schemas.js';
