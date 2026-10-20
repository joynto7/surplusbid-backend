import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';

/**
 * The Claude client, or null when no ANTHROPIC_API_KEY is configured. Every
 * caller checks `llm` and falls back to the deterministic engines, so the
 * marketplace never depends on the model being reachable.
 */
export const llm = env.ai.apiKey ? new Anthropic({ apiKey: env.ai.apiKey, timeout: 45_000, maxRetries: 1 }) : null;

export const AI_MODEL = env.ai.model;

/**
 * Server-side refusal fallback: if Claude's safety classifiers decline a
 * request, the API re-runs it on Anthropic's recommended fallback model in the
 * same call instead of returning the refusal.
 */
export const FALLBACK_PARAMS: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: 'default' } = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

export type AiMode = 'ai' | 'smart';

/** Logs model failures without leaking them to API clients; callers then use their fallback path. */
export function logAiError(feature: string, err: unknown) {
  if (err instanceof Anthropic.APIError) {
    console.error(`[ai:${feature}] Claude API error ${err.status ?? ''}: ${err.message}`);
  } else {
    console.error(`[ai:${feature}]`, err);
  }
}
