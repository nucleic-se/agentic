/**
 * Budget-aware agent context assembler.
 *
 * Implements IAgentContextAssembler with token-budget enforcement.
 * Given a full message history and a token budget, it selects the most
 * recent messages that fit within the budget after reserving space for
 * the system prompt.
 *
 * Selection strategy (tail-first):
 *   1. Estimate tokens for the system prompt; reserve that from the budget.
 *   2. Walk messages from newest to oldest, accumulating token estimates.
 *   3. Stop when the next message would exceed the remaining budget.
 *   4. Return the selected tail in chronological order.
 *
 * Tool-result messages are kept together with their preceding assistant
 * message (the one containing the toolCalls that produced them) to avoid
 * orphaned tool results that confuse the model.
 *
 * @module runtime
 */

import type {
    IAgentContextAssembler,
    AgentContextInput,
    AgentContextOutput,
} from '../contracts/IAgentContextAssembler.js';
import type { Message } from '../contracts/llm.js';
import { estimateTokens } from '../utils.js';

export interface AgentContextAssemblerConfig {
    /**
     * Static system prompt. Included in every assembled context.
     * Token cost is deducted from the budget before message selection.
     */
    systemPrompt: string;

    /**
     * Minimum number of recent messages to always include, even if they
     * technically exceed the budget. Ensures the model always sees at
     * least the latest exchange. Default: 2 (last user + last assistant).
     */
    minRecentMessages?: number;
}

/** Estimate tokens for a single message (content + JSON overhead for tool calls). */
function estimateMessageTokens(msg: Message): number {
    let tokens = estimateTokens(msg.content);
    // Role tag overhead (~4 tokens)
    tokens += 4;
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
            tokens += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.args));
        }
    }
    if (msg.role === 'tool_result' && msg.toolCallId) {
        tokens += estimateTokens(msg.toolCallId);
    }
    return tokens;
}

export class AgentContextAssembler implements IAgentContextAssembler {
    private readonly systemPrompt: string;
    private readonly minRecentMessages: number;

    constructor(config: AgentContextAssemblerConfig) {
        this.systemPrompt = config.systemPrompt;
        this.minRecentMessages = config.minRecentMessages ?? 2;
    }

    async assemble(input: AgentContextInput): Promise<AgentContextOutput> {
        const { messages, tokenBudget } = input;

        if (messages.length === 0) {
            return { system: this.systemPrompt, messages: [] };
        }

        const systemTokens = estimateTokens(this.systemPrompt);
        let remainingBudget = Math.max(0, tokenBudget - systemTokens);

        // Pre-compute token estimates for each message.
        const msgTokens = messages.map(estimateMessageTokens);

        // Walk backwards, accumulating messages that fit.
        let selectedStart = messages.length;
        let usedTokens = 0;

        for (let i = messages.length - 1; i >= 0; i--) {
            const cost = msgTokens[i];

            // Always include minRecentMessages from the tail.
            const messagesIncluded = messages.length - i;
            if (messagesIncluded <= this.minRecentMessages) {
                usedTokens += cost;
                selectedStart = i;
                continue;
            }

            if (usedTokens + cost > remainingBudget) {
                break;
            }

            usedTokens += cost;
            selectedStart = i;
        }

        // Ensure we don't start on an orphaned tool_result — back up to
        // include the preceding assistant message that triggered it.
        while (
            selectedStart > 0 &&
            selectedStart < messages.length &&
            messages[selectedStart].role === 'tool_result'
        ) {
            selectedStart--;
        }

        const selected = messages.slice(selectedStart);

        return {
            system: this.systemPrompt,
            messages: selected,
        };
    }
}
