/**
 * Zod schemas for the four §4 interfaces.
 *
 * Two categories of schema live here and they have different rules:
 *
 *  - INPUT schemas (EvidenceBundle, ShadowReport) validate JSON handed to us by
 *    Kaustubh's pipeline. They can use the full Zod surface.
 *
 *  - MODEL-OUTPUT schemas (…ModelOutput) are compiled to JSON Schema and sent to
 *    the API via `output_config.format`. Structured outputs impose real limits:
 *    no recursive schemas, no `minLength` / `maximum` / numeric constraints, and
 *    every object gets `additionalProperties: false` with all fields required.
 *    So: no `.min()` / `.max()` anywhere in an output schema, and optionality is
 *    expressed as `.nullable()`, never `.optional()`. Ranges are clamped in
 *    post-processing instead.
 *
 * The model-output schemas deliberately OMIT every field that code can compute
 * deterministically (§12: "an LLM doing something deterministic" is an
 * anti-requirement). Those fields are spliced back in by the post-processors:
 *
 *    observedCalls / lastCalledBlock  <- derived from callHistory x gatedFunctions
 *    agreementRate                    <- computed by Kaustubh's code, passed through
 */

// zod/v4 (shipped inside the zod 3.25 package) is what @anthropic-ai/sdk's
// zodOutputFormat helper is typed against. Importing plain 'zod' gives the v3
// classic API and fails to satisfy the helper's signature.
import * as z from 'zod/v4';

/* ────────────────────────────────────────────────────────────────────────── */
/* INPUT — EvidenceBundle (produced by Scout)                                 */
/* ────────────────────────────────────────────────────────────────────────── */

export const KeeperProviderSchema = z.enum(['chainlink', 'gelato', 'defender', 'manual']);

export const DeadKeeperSchema = z.object({
  address: z.string(),
  chainId: z.number(),
  provider: KeeperProviderSchema,
});

export const UpkeepSchema = z.object({
  id: z.string(),
  targetContract: z.string(),
  checkFunctionSig: z.string().nullable(),
  performFunctionSig: z.string().nullable(),
  adminAddress: z.string(),
  balance: z.string(),
});

export const PermissionRefSchema = z.object({
  contract: z.string(),
  roleHash: z.string(),
  grantedAtBlock: z.number(),
  stillActive: z.boolean(),
});

export const ContractInfoSchema = z.object({
  address: z.string(),
  name: z.string().nullable(),
  isProxy: z.boolean(),
  implementationAddress: z.string().nullable(),
  verifiedSource: z.string().nullable(),
  abi: z.array(z.unknown()).nullable(),
});

export const CallHistoryEntrySchema = z.object({
  contract: z.string(),
  selector: z.string(),
  functionName: z.string().nullable(),
  count: z.number(),
  firstBlock: z.number(),
  lastBlock: z.number(),
});

export const ChainContextSchema = z.object({
  chainId: z.number(),
  chainName: z.string(),
  currentBlock: z.number(),
});

export const EvidenceBundleSchema = z.object({
  deadKeeper: DeadKeeperSchema,
  upkeep: UpkeepSchema.optional(),
  permissions: z.array(PermissionRefSchema),
  contracts: z.record(z.string(), ContractInfoSchema),
  callHistory: z.array(CallHistoryEntrySchema),
  chainContext: ChainContextSchema,
});

/* ────────────────────────────────────────────────────────────────────────── */
/* OUTPUT — PermissionAnalysis (produced by Analyst)                          */
/* ────────────────────────────────────────────────────────────────────────── */

export const ResolutionMethodSchema = z.enum([
  'source_constant',
  'known_standard',
  'brute_force',
  'unresolved',
]);

export const ClassificationSchema = z.enum(['load_bearing', 'vestigial', 'unknown']);

export const TriggerKindSchema = z.enum(['block', 'event', 'schedule', 'unknown']);

export const CallRefSchema = z.object({
  contract: z.string(),
  fn: z.string(),
  args: z.array(z.string()),
});

export const AnalyzedPermissionSchema = z.object({
  contract: z.string(),
  roleHash: z.string(),
  roleName: z.string().nullable(),
  resolutionMethod: ResolutionMethodSchema,
  gatedFunctions: z.array(z.string()),
  observedCalls: z.number(),
  lastCalledBlock: z.number().nullable(),
  classification: ClassificationSchema,
  confidence: z.number(),
  reasoning: z.string(),
});

export const AutomationIntentSchema = z.object({
  triggerKind: TriggerKindSchema,
  conditionSummary: z.string(),
  conditionCall: CallRefSchema.nullable(),
  action: CallRefSchema.nullable(),
  confidence: z.number(),
  reasoning: z.string(),
});

export const PermissionAnalysisSchema = z.object({
  permissions: z.array(AnalyzedPermissionSchema),
  automationIntent: AutomationIntentSchema,
  declaredUnknowns: z.array(z.string()),
});

/**
 * What the model is actually asked to return.
 *
 * `observedCalls` and `lastCalledBlock` are dropped: they are a deterministic
 * join of callHistory against the model's `gatedFunctions`, so code computes
 * them. Asking the model to count is both wasteful and a correctness risk.
 */
export const AnalyzedPermissionModelOutputSchema = AnalyzedPermissionSchema.omit({
  observedCalls: true,
  lastCalledBlock: true,
});

export const PermissionAnalysisModelOutputSchema = z.object({
  permissions: z.array(AnalyzedPermissionModelOutputSchema),
  automationIntent: AutomationIntentSchema,
  declaredUnknowns: z.array(z.string()),
});

/* ────────────────────────────────────────────────────────────────────────── */
/* INPUT — ShadowReport (produced by Shadow)                                  */
/* ────────────────────────────────────────────────────────────────────────── */

export const JobSemanticsSchema = z.object({
  description: z.string(),
  targetContract: z.string(),
  toleranceWindowSeconds: z.number().nullable(),
  consequenceOfMissedAction: z.string(),
});

export const ObservationSchema = z.object({
  block: z.number(),
  timestamp: z.number(),
  groundTruth: z.object({ shouldAct: z.boolean(), reason: z.string() }),
  newWorkflow: z.object({ wouldAct: z.boolean(), reason: z.string() }),
  chainState: z.record(z.string(), z.string()),
});

export const ShadowReportSchema = z.object({
  analysis: PermissionAnalysisSchema,
  jobSemantics: JobSemanticsSchema,
  observations: z.array(ObservationSchema),
  windowBlocks: z.number(),
  averageBlockTimeSeconds: z.number(),
});

/* ────────────────────────────────────────────────────────────────────────── */
/* OUTPUT — ReadinessVerdict (produced by Adjudicator)                        */
/* ────────────────────────────────────────────────────────────────────────── */

export const DisagreementClassificationSchema = z.enum([
  'benign_timing',
  'benign_old_keeper_wasteful',
  'regression',
]);

export const DisagreementSchema = z.object({
  block: z.number(),
  oldDecision: z.string(),
  newDecision: z.string(),
  classification: DisagreementClassificationSchema,
  reasoning: z.string(),
});

export const VerdictSchema = z.enum(['ready', 'not_ready']);

export const ReadinessVerdictSchema = z.object({
  verdict: VerdictSchema,
  agreementRate: z.number(),
  disagreements: z.array(DisagreementSchema),
  blockingIssues: z.array(z.string()),
  reasoning: z.string(),
});

/**
 * What the model is actually asked to return.
 *
 * `agreementRate` is omitted on purpose. §6 hard requirement 3: it is computed
 * by Kaustubh's code and is context for the model, never the decision. Keeping
 * it out of the response schema means the model physically cannot emit it, and
 * the number the caller sees is always the one code computed.
 */
export const ReadinessVerdictModelOutputSchema = ReadinessVerdictSchema.omit({
  agreementRate: true,
});
