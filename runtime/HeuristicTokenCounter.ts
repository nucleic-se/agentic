import type { ITokenCounter } from '../contracts/ITokenCounter.js';
import { estimateTokens } from '../utils.js';

/**
 * Simple heuristic token counter using the chars/4 ratio.
 *
 * Accuracy: roughly ±15% for English prose; less accurate for code or non-English text.
 * Speed: O(n), no external dependencies.
 *
 * This is the default implementation for applications that do not need
 * provider-specific tokenizer accuracy.
 */
export class HeuristicTokenCounter implements ITokenCounter {
    countTokens(text: string): number {
        return estimateTokens(text);
    }

    countTokensForMessages(messages: { role: string; content: unknown }[]): number {
        let total = 0;
        for (const msg of messages) {
            if (typeof msg.content === 'string') {
                total += estimateTokens(msg.content);
            } else if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
                        total += estimateTokens(part.text);
                    }
                }
            }
            // ~4 tokens overhead per message for role + formatting
            total += 4;
        }
        return total;
    }
}
