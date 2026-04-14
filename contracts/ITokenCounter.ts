/**
 * Token counting interface.
 *
 * Provides a universal primitive for token estimation across agentic applications.
 * Implementations may use provider-specific tokenizers or heuristics.
 */

/**
 * Token counter interface for estimating token usage.
 */
export interface ITokenCounter {
    /**
     * Count tokens in a text string.
     *
     * @param text - The text to count tokens for.
     * @returns Estimated token count.
     */
    countTokens(text: string): number;

    /**
     * Count tokens across multiple messages.
     * Includes overhead for message structure (roles, formatting).
     *
     * @param messages - Array of messages to count.
     * @returns Total estimated token count.
     */
    countTokensForMessages(messages: { role: string; content: unknown }[]): number;
}
