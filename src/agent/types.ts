/**
 * THE FROZEN §4 INTERFACES.
 *
 * These are transcribed verbatim from AI-LAYER-SPEC.md §4 and are the contract
 * Kaustubh codes against. They are the source of truth; the Zod schemas in
 * schemas.ts are checked against them at the bottom of this file, so if the two
 * ever drift apart `npm run typecheck` fails instead of integration breaking.
 *
 * DO NOT change anything in this file without messaging Kaustubh first.
 */

import type * as z from 'zod/v4';
import type {
  EvidenceBundleSchema,
  PermissionAnalysisSchema,
  ShadowReportSchema,
  ReadinessVerdictSchema,
} from './schemas.js';

/* ============ INPUT to Analyst — produced by Scout ============ */

export interface EvidenceBundle {
  deadKeeper: {
    address: string;
    chainId: number;
    provider: 'chainlink' | 'gelato' | 'defender' | 'manual';
  };

  /** Present when discovered from a keeper registry; absent for a bare address. */
  upkeep?: {
    id: string;
    targetContract: string;
    checkFunctionSig: string | null;
    performFunctionSig: string | null;
    adminAddress: string;
    balance: string;
  };

  /** Every (contract, role) pair the dead keeper was granted. */
  permissions: Array<{
    contract: string;
    roleHash: string;
    grantedAtBlock: number;
    stillActive: boolean;
  }>;

  /** Source + ABI for every contract above. Keyed by lowercased address. */
  contracts: Record<
    string,
    {
      address: string;
      name: string | null;
      isProxy: boolean;
      implementationAddress: string | null;
      verifiedSource: string | null;
      abi: unknown[] | null;
    }
  >;

  /** What the dead keeper actually did, decoded. Empty array = no history found. */
  callHistory: Array<{
    contract: string;
    selector: string;
    functionName: string | null;
    count: number;
    firstBlock: number;
    lastBlock: number;
  }>;

  chainContext: {
    chainId: number;
    chainName: string;
    currentBlock: number;
  };
}

/* ============ OUTPUT of Analyst ============ */

export interface PermissionAnalysis {
  permissions: Array<{
    contract: string;
    roleHash: string;
    roleName: string | null;
    resolutionMethod: 'source_constant' | 'known_standard' | 'brute_force' | 'unresolved';
    gatedFunctions: string[];
    observedCalls: number;
    lastCalledBlock: number | null;
    classification: 'load_bearing' | 'vestigial' | 'unknown';
    confidence: number;
    reasoning: string;
  }>;

  automationIntent: {
    triggerKind: 'block' | 'event' | 'schedule' | 'unknown';
    conditionSummary: string;
    conditionCall: { contract: string; fn: string; args: string[] } | null;
    action: { contract: string; fn: string; args: string[] } | null;
    confidence: number;
    reasoning: string;
  };

  /** Anything the agent could not determine. Surfaced to the user, never silently dropped. */
  declaredUnknowns: string[];
}

/* ============ INPUT to Adjudicator — produced by Shadow ============ */

export interface ShadowReport {
  analysis: PermissionAnalysis;

  jobSemantics: {
    description: string;
    targetContract: string;
    /** How long the job has to act before something bad happens. THE KEY FIELD. */
    toleranceWindowSeconds: number | null;
    consequenceOfMissedAction: string;
  };

  observations: Array<{
    block: number;
    timestamp: number;
    groundTruth: { shouldAct: boolean; reason: string };
    newWorkflow: { wouldAct: boolean; reason: string };
    chainState: Record<string, string>;
  }>;

  windowBlocks: number;
  averageBlockTimeSeconds: number;
}

/* ============ OUTPUT of Adjudicator ============ */

export interface ReadinessVerdict {
  verdict: 'ready' | 'not_ready';
  agreementRate: number;
  disagreements: Array<{
    block: number;
    oldDecision: string;
    newDecision: string;
    classification: 'benign_timing' | 'benign_old_keeper_wasteful' | 'regression';
    reasoning: string;
  }>;
  blockingIssues: string[];
  reasoning: string;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* COMPILE-TIME DRIFT GUARD                                                   */
/*                                                                            */
/* Each assertion below fails to compile if the Zod schema and the frozen      */
/* interface stop describing the same type. This is the whole point of the     */
/* file: schema drift becomes a build error, not a 2am integration surprise.   */
/* ────────────────────────────────────────────────────────────────────────── */

/** True only if A and B are mutually assignable. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** Compiles only when T is exactly `true`. */
type Assert<T extends true> = T;

export type _AssertEvidenceBundle = Assert<
  MutuallyAssignable<EvidenceBundle, z.infer<typeof EvidenceBundleSchema>>
>;
export type _AssertPermissionAnalysis = Assert<
  MutuallyAssignable<PermissionAnalysis, z.infer<typeof PermissionAnalysisSchema>>
>;
export type _AssertShadowReport = Assert<
  MutuallyAssignable<ShadowReport, z.infer<typeof ShadowReportSchema>>
>;
export type _AssertReadinessVerdict = Assert<
  MutuallyAssignable<ReadinessVerdict, z.infer<typeof ReadinessVerdictSchema>>
>;
