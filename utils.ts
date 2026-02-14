/**
 * Shared utility functions.
 *
 * Small, dependency-free helpers used across prompt composition,
 * pipelines, and domain layers.
 */

/** Rough token count estimate (~4 chars per token). */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
}
