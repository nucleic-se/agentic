/**
 * Grouped, two-pass conversation assembler.
 *
 * Replaces the old tail-trimming AgentContextAssembler with an
 * atomicity-preserving, compress-before-drop implementation.
 *
 * Key invariant: an assistant message and all immediately following
 * tool_result messages whose toolCallId matches one of the assistant's
 * toolCalls[].id form one atomic group. Groups are never split.
 *
 * Two-pass pruning:
 *   Pass 1 — compress: call onCompress on each message in low-scoring
 *             groups. If the group shrinks, use the compressed version.
 *   Pass 2 — drop: if still over budget, drop lowest-scoring groups
 *             entirely, calling onDrop for each dropped message.
 *
 * @module runtime
 */

import type {
    IAgentContextAssembler,
    AgentContextInput,
    AgentContextOutput,
} from '../contracts/IAgentContextAssembler.js';
import type { Message, ToolResultMessage } from '../contracts/llm.js';
import { estimateTokens } from '../utils.js';

// ── Config ────────────────────────────────────────────────────────────────────

export interface ConversationAssemblerConfig {
    systemPrompt: string;
    tokenBudget: number;
    /** Always protect the last N groups regardless of score. Default: 2. */
    minRecentGroups?: number;
    /** Score function. Higher score = survives longer. Default: group index (recency). */
    scorer?(msg: Message, index: number): number;
    /** Sticky predicate. Sticky groups are never candidates. Default: msg.sticky === true. */
    sticky?(msg: Message, index: number): boolean;
    /** Compress a single message. Return compressed message or null (= keep as-is). */
    onCompress?(msg: Message): Promise<Message | null>;
    /** Called for each message that is dropped. */
    onDrop?(msg: Message): void;
}

// ── Group ─────────────────────────────────────────────────────────────────────

interface MessageGroup {
    messages: Message[];
    firstIndex: number;
    score: number;
    tokens: number;
    dropped: boolean;
}

// ── Token estimation ──────────────────────────────────────────────────────────

function estimateMessageTokens(msg: Message): number {
    let tokens = estimateTokens(msg.content);
    tokens += 4; // role overhead
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
            tokens += estimateTokens(tc.name) + estimateTokens(JSON.stringify(tc.args));
        }
    }
    if (msg.role === 'tool_result') {
        tokens += estimateTokens(msg.toolCallId);
    }
    return tokens;
}

function groupTokens(group: MessageGroup): number {
    return group.messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

// ── Default compress ──────────────────────────────────────────────────────────

const COMPRESS_THRESHOLD_TOKENS = 300;

async function defaultOnCompress(msg: Message): Promise<Message | null> {
    if (msg.role !== 'tool_result') return null;

    const tokens = estimateMessageTokens(msg);
    if (tokens <= COMPRESS_THRESHOLD_TOKENS) return null;

    const toolMsg = msg as ToolResultMessage;
    const toolName = toolMsg.toolName ?? '';
    const content = msg.content;

    let compressed: string | null = null;

    if (toolName === 'read_file') {
        const lines = content.split('\n');
        const numberedLineRe = /^\s*\d+\s+│/;
        const headerLines = lines.filter((l, i) => i === 0 || !numberedLineRe.test(l) ? false : false);
        // Keep header (non-numbered) + first 3 numbered + last 3 numbered
        const header: string[] = [];
        const numbered: string[] = [];
        for (const line of lines) {
            if (numberedLineRe.test(line)) {
                numbered.push(line);
            } else {
                header.push(line);
            }
        }
        const head = numbered.slice(0, 3);
        const tail = numbered.slice(-3);
        const elided = numbered.length > 6;
        const parts = [
            ...header,
            ...head,
            ...(elided ? ['… [lines elided by context manager]'] : []),
            ...(elided ? tail : []),
        ];
        void headerLines; // suppress unused
        compressed = parts.join('\n');
    } else if (toolName === 'search') {
        const lines = content.split('\n');
        const kept = lines.filter(l => l.includes('▶') || /^\S/.test(l) || l.includes('...'));
        compressed = kept.join('\n');
    } else if (toolName === 'html_query') {
        const lines = content.split('\n');
        const kept = lines.filter(l =>
            l.startsWith('[') ||
            /^line \d+/i.test(l) ||
            /^\d+ match/.test(l)
        );
        compressed = kept.join('\n');
    } else {
        // Fallback: first 400 chars
        if (content.length > 400) {
            compressed = content.slice(0, 400) + '\n… [truncated by context manager]';
        }
    }

    if (compressed === null) return null;
    if (estimateTokens(compressed) >= tokens) return null; // no improvement

    return { ...msg, content: compressed };
}

// ── Default sticky ────────────────────────────────────────────────────────────

function defaultSticky(msg: Message, _index: number): boolean {
    if (msg.role === 'user' && (msg as { sticky?: boolean }).sticky === true) return true;
    return false;
}

// ── Group builder ─────────────────────────────────────────────────────────────

function buildGroups(messages: Message[]): MessageGroup[] {
    const groups: MessageGroup[] = [];
    let i = 0;

    while (i < messages.length) {
        const msg = messages[i];

        if (msg.role === 'assistant') {
            // Collect tool_result messages whose toolCallId matches this assistant's toolCalls
            const callIds = new Set((msg.toolCalls ?? []).map(tc => tc.id));
            const groupMsgs: Message[] = [msg];
            let j = i + 1;
            while (j < messages.length && messages[j].role === 'tool_result') {
                const tr = messages[j] as ToolResultMessage;
                if (callIds.has(tr.toolCallId)) {
                    groupMsgs.push(tr);
                    j++;
                } else {
                    break;
                }
            }
            groups.push({
                messages: groupMsgs,
                firstIndex: i,
                score: 0,
                tokens: 0,
                dropped: false,
            });
            i = j;
        } else {
            // User messages (and orphaned tool_results) are self-contained groups
            groups.push({
                messages: [msg],
                firstIndex: i,
                score: 0,
                tokens: 0,
                dropped: false,
            });
            i++;
        }
    }

    return groups;
}

// ── Assembler ─────────────────────────────────────────────────────────────────

export class AgentContextAssembler implements IAgentContextAssembler {
    private readonly systemPrompt: string;
    private readonly tokenBudget: number;
    private readonly minRecentGroups: number;
    private readonly scorer: (msg: Message, index: number) => number;
    private readonly stickyFn: (msg: Message, index: number) => boolean;
    private readonly onCompress: (msg: Message) => Promise<Message | null>;
    private readonly onDrop?: (msg: Message) => void;

    constructor(config: ConversationAssemblerConfig) {
        this.systemPrompt = config.systemPrompt;
        this.tokenBudget = config.tokenBudget;
        this.minRecentGroups = config.minRecentGroups ?? 2;
        this.scorer = config.scorer ?? ((_msg, index) => index);
        this.stickyFn = config.sticky ?? defaultSticky;
        this.onCompress = config.onCompress ?? defaultOnCompress;
        this.onDrop = config.onDrop;
    }

    async assemble(input: AgentContextInput): Promise<AgentContextOutput> {
        const { messages } = input;
        const tokenBudget = input.tokenBudget ?? this.tokenBudget;

        if (messages.length === 0) {
            return { system: this.systemPrompt, messages: [] };
        }

        // Build groups
        const groups = buildGroups(messages);

        // Compute token counts and scores per group
        const systemTokens = estimateTokens(this.systemPrompt);
        const messageBudget = Math.max(0, tokenBudget - systemTokens);

        for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            group.tokens = groupTokens(group);
            // Score = score of first message; higher = more recent = survives
            group.score = this.scorer(group.messages[0], gi);
        }

        // Fast path: if total <= budget, return all messages unchanged
        const totalTokens = groups.reduce((sum, g) => sum + g.tokens, 0);
        if (totalTokens <= messageBudget) {
            return { system: this.systemPrompt, messages };
        }

        // Apply sticky and minRecentGroups overrides (score = Infinity)
        const minRecentStart = Math.max(0, groups.length - this.minRecentGroups);
        for (let gi = 0; gi < groups.length; gi++) {
            const group = groups[gi];
            const isSticky = group.messages.some((m, mi) => this.stickyFn(m, group.firstIndex + mi));
            if (isSticky || gi >= minRecentStart) {
                group.score = Infinity;
            }
        }

        // Identify candidates (non-sticky, non-recent) sorted ascending by score
        const candidates = groups
            .filter(g => g.score !== Infinity)
            .sort((a, b) => a.score - b.score);

        // Pass 1 — compress: try to shrink each candidate group
        for (const group of candidates) {
            const compressed: Message[] = [];
            let changed = false;
            for (const msg of group.messages) {
                const result = await this.onCompress(msg);
                if (result !== null) {
                    compressed.push(result);
                    changed = true;
                } else {
                    compressed.push(msg);
                }
            }
            if (changed) {
                group.messages = compressed;
                group.tokens = groupTokens(group);
            }
        }

        // Check if we're now within budget after compression
        const afterCompressTotal = groups.reduce((sum, g) => sum + g.tokens, 0);
        if (afterCompressTotal <= messageBudget) {
            const surviving = groups.filter(g => !g.dropped).flatMap(g => g.messages);
            return { system: this.systemPrompt, messages: surviving };
        }

        // Pass 2 — drop: drop candidates lowest-score-first until within budget
        let currentTotal = afterCompressTotal;
        for (const group of candidates) {
            if (currentTotal <= messageBudget) break;
            group.dropped = true;
            for (const msg of group.messages) {
                this.onDrop?.(msg);
            }
            currentTotal -= group.tokens;
        }

        // Collect surviving messages in original order
        const surviving = groups.filter(g => !g.dropped).flatMap(g => g.messages);
        return { system: this.systemPrompt, messages: surviving };
    }
}
