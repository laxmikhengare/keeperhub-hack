// dotenv must load before anything reads process.env. Keeping this as the first
// import means `tsx`, `vitest` and the eval runner all pick up .env with no
// per-script flags and no --env-file plumbing.
import 'dotenv/config';

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type * as z from 'zod/v4';

import { AgentConfigError, AgentRefusalError, AgentSchemaError, AgentTimeoutError } from './errors.js';

/** The model the spec pins. Do not change without re-running the eval suite. */
export const PRIMARY_MODEL = 'claude-opus-5';

/**
 * Where a refused request goes.
 *
 * Permission analysis is security-adjacent enough that Opus 5's classifiers can
 * conceivably fire on it, and a refusal arrives as HTTP 200 rather than an
 * error — so an unguarded caller crashes mid-demo. We do the retry manually
 * rather than via the server-side `fallbacks` beta, because `.parse()` lives on
 * the non-beta client and mixing the two is not worth the complexity here.
 */
export const FALLBACK_MODEL = 'claude-opus-4-8';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

let cached: Anthropic | null = null;

/**
 * The shared client. Zero-arg construction on purpose: the SDK resolves
 * ANTHROPIC_API_KEY (or an `ant auth login` profile) itself.
 */
export function getClient(): Anthropic {
  if (cached) return cached;

  const key = process.env['ANTHROPIC_API_KEY'];
  if (!key || key.trim() === '') {
    throw new AgentConfigError(
      'ANTHROPIC_API_KEY is not set.\n' +
        'Create a .env file in the repo root containing:\n\n' +
        '    ANTHROPIC_API_KEY=sk-ant-...\n\n' +
        'See .env.example. The .env file is gitignored and must never be committed.',
    );
  }

  cached = new Anthropic();
  return cached;
}

export interface CallOptions<T extends z.ZodType> {
  /** Zod schema the response is constrained to and validated against. */
  schema: T;
  /** Stable system prompt. Cached — keep it byte-identical across calls. */
  system: string;
  /** Per-request evidence. Goes after the cache breakpoint. */
  user: string;
  /** Thinking depth / token spend. Defaults to ANALYST_EFFORT or 'high'. */
  effort?: Effort;
  /** Caps thinking + output together. Thinking is ON by default on Opus 5. */
  maxTokens?: number;
  /** Wall-clock budget for a single attempt, ms. */
  timeoutMs?: number;
  /** Label used in error messages so failures name the component. */
  label?: string;
}

interface RawResult {
  text: string;
  model: string;
  usedFallback: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

function extractText(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * One streamed attempt against one model.
 *
 * Streaming rather than `.parse()` is deliberate: `.parse()` is non-streaming
 * only, and the large fixtures (single-role.json is 177 KB of Solidity) need a
 * high max_tokens, which on a non-streaming request risks an HTTP timeout. The
 * response is still schema-constrained via output_config.format; we validate it
 * ourselves on the way out.
 */
async function attempt<T extends z.ZodType>(
  model: string,
  opts: CallOptions<T>,
  maxTokens: number,
  effort: Effort,
  timeoutMs: number,
): Promise<Anthropic.Message> {
  const client = getClient();

  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      // Thinking is on by default on Opus 5; state it explicitly for the record.
      // Never disable it — on this model that has known failure modes (tool
      // calls emitted as prose, <thinking> tags leaking into output). Lower
      // `effort` instead when cost or latency matters.
      thinking: { type: 'adaptive' },
      output_config: {
        effort,
        format: zodOutputFormat(opts.schema),
      },
      system: [
        {
          type: 'text',
          text: opts.system,
          // The system prompt is the stable prefix shared by every eval row.
          // Opus 5's minimum cacheable prefix is 512 tokens, so even the
          // shorter adjudicator prompt caches.
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: opts.user }],
    },
    { timeout: timeoutMs },
  );

  return await stream.finalMessage();
}

/**
 * Call the model, enforce the schema, and convert every failure mode into a
 * typed error. Both components go through here so the §4 error contract is
 * enforced in exactly one place.
 */
export async function callModel<T extends z.ZodType>(
  opts: CallOptions<T>,
): Promise<{ value: z.infer<T>; meta: RawResult }> {
  const label = opts.label ?? 'agent';
  const effort = opts.effort ?? ((process.env['ANALYST_EFFORT'] as Effort | undefined) ?? 'high');
  const maxTokens = opts.maxTokens ?? 32_000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;

  let message: Anthropic.Message;
  let usedFallback = false;

  try {
    message = await attempt(PRIMARY_MODEL, opts, maxTokens, effort, timeoutMs);
  } catch (err) {
    throw mapTransportError(err, label);
  }

  // A refusal is HTTP 200 with an empty or partial content array. Check it
  // before touching content, or this crashes on `content[0]`.
  if (message.stop_reason === 'refusal') {
    try {
      message = await attempt(FALLBACK_MODEL, opts, maxTokens, effort, timeoutMs);
      usedFallback = true;
    } catch (err) {
      throw mapTransportError(err, label);
    }

    if (message.stop_reason === 'refusal') {
      throw new AgentRefusalError(
        message.stop_details,
        `[${label}] both ${PRIMARY_MODEL} and ${FALLBACK_MODEL} refused the request`,
      );
    }
  }

  if (message.stop_reason === 'max_tokens') {
    throw new AgentSchemaError(
      `[${label}] response hit max_tokens (${maxTokens}) and is truncated. ` +
        `Raise maxTokens or lower effort — do not disable thinking.`,
      { stop_reason: message.stop_reason, usage: message.usage },
    );
  }

  const text = extractText(message);
  if (!text.trim()) {
    throw new AgentSchemaError(`[${label}] model returned no text content`, {
      stop_reason: message.stop_reason,
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AgentSchemaError(`[${label}] model output was not valid JSON`, {
      preview: text.slice(0, 400),
    });
  }

  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) {
    throw new AgentSchemaError(
      `[${label}] model output failed schema validation`,
      parsed.error.issues.slice(0, 10),
    );
  }

  return {
    value: parsed.data as z.infer<T>,
    meta: {
      text,
      model: message.model,
      usedFallback,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}

function mapTransportError(err: unknown, label: string): Error {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AgentTimeoutError(`[${label}] model call timed out`);
  }
  if (err instanceof AgentConfigError) return err;
  if (err instanceof Error) {
    err.message = `[${label}] ${err.message}`;
    return err;
  }
  return new AgentSchemaError(`[${label}] unknown transport failure`, err);
}
