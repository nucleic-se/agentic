import { isDeepStrictEqual } from 'node:util';
import { projectToolOutput } from './ToolOutput.js';
export { projectToolOutput } from './ToolOutput.js';
import type { Message, ToolDefinition, ToolResultMessage } from '../contracts/llm.js';
import type { ITokenCounter } from '../contracts/ITokenCounter.js';
import type { IPromptContributor, PromptContributionContext, PromptSection, SystemSectionRange } from '../contracts/IPromptEngine.js';
import { HeuristicTokenCounter } from './HeuristicTokenCounter.js';
import { ContextBudgetExceededError, renderPromptSections, sectionPriority, sectionProtected, snapshotPromptSection } from './PromptEngine.js';

export { ContextBudgetExceededError } from './PromptEngine.js';
export class ContextCompressionError extends Error {
    constructor(message: string) { super(message); this.name = 'ContextCompressionError'; }
}

export interface ContextCompositionInput {
    messages: readonly Message[];
    system?: string;
    sections?: readonly PromptSection[];
    tools?: readonly ToolDefinition[];
    responseSchema?: Record<string, unknown>;
    /** Complete estimated context window, including the reserved output. */
    tokenBudget: number;
    reservedOutputTokens?: number;
    signal?: AbortSignal;
}
export interface ContextTokenOptions {
    tokenCounter?: ITokenCounter;
    /** Provider/resolution-specific image estimate, independent of base64 length. */
    imageTokenEstimate?: number;
}
export interface ContextCompositionOptions extends ContextTokenOptions {
    /** Render source IDs as model-visible data when tools require exact receipt references. */
    includeToolCallIds?: boolean;
    minRecentGroups?: number;
    /** Retain human instructions through tools and synthetic updates. `all` preserves
     * objectives and later corrections; `latest` supports explicitly disposable history.
     * Messages without provenance are treated as human. */
    protectUserMessages?: 'latest' | 'all';
    /** Opt-in model-facing cap for recoverable text tool results, including recent errors.
     * Requires referenceToolResult; originals and call identity remain intact. */
    maxToolResultCharacters?: number;
    /** Return an exact-source retrieval instruction for retained text.
     * Without maxToolResultCharacters, only older results under budget pressure are considered,
     * in priority order; fitting contexts stay intact. Protected groups may retain
     * a recoverable preview when their full text alone exceeds the budget.
     * Return null when the source cannot be recovered with the current tool grants.
     * The host must preserve the original message at this index. */
    referenceToolResult?(message: ToolResultMessage, messageIndex: number, tools: readonly ToolDefinition[]): string | null;
    scoreGroup?(messages: readonly Message[], groupIndex: number): number;
    /** Add protection to the built-in sticky-message rule. */
    protectMessage?(message: Message, messageIndex: number): boolean;
    compressMessage?(message: Message): Promise<Message | null> | Message | null;
    compressSection?(section: PromptSection): Promise<string | null> | string | null;
    onDrop?(message: Message): void;
    onDropSection?(section: PromptSection): void;
}
export type { ContextTokenUsage, ContextDecision, ContextReport } from '../contracts/IAgentContextAssembler.js';
import type { ContextTokenUsage, ContextDecision } from '../contracts/IAgentContextAssembler.js';
export interface ContextCompositionResult {
    tokenBudget: number;
    systemSections: SystemSectionRange[];
    system: string;
    messages: Message[];
    includedSections: PromptSection[];
    excludedSections: PromptSection[];
    usage: ContextTokenUsage;
    decisions: ContextDecision[];
}

function integer(value: number, name: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
    return value;
}
function count(value: number): number {
    if (!Number.isFinite(value) || value < 0) throw new RangeError('Token counter must return a non-negative finite estimate');
    return Math.ceil(value);
}

/** Estimate every model-facing input component with the same caller-supplied counter. */
export function estimateContextTokens(
    input: Pick<ContextCompositionInput, 'system' | 'messages' | 'tools' | 'responseSchema' | 'reservedOutputTokens'>,
    options: ContextTokenOptions = {},
): ContextTokenUsage {
    const counter = options.tokenCounter ?? new HeuristicTokenCounter();
    const imageCost = integer(options.imageTokenEstimate ?? 4096, 'imageTokenEstimate', 1);
    const systemTokens = input.system ? count(counter.countTokensForMessages([{ role: 'system', content: input.system }])) : 0;
    let messageTokens = 0;
    for (const message of input.messages) {
        const rich = message.role === 'tool_result' && message.contentBlocks?.length ? message.contentBlocks : undefined;
        messageTokens += count(counter.countTokensForMessages([{ role: message.role,
            content: rich ? rich.filter(block => block.type === 'text').map(block => ({ ...block })) : message.content }]));
        if (rich) messageTokens += rich.filter(block => block.type === 'image').length * imageCost;
        if (message.role === 'assistant' && message.toolCalls?.length) {
            messageTokens += count(counter.countTokens(JSON.stringify(message.toolCalls)));
        }
        // Opaque protocol annotations occupy context too. Counting their serialized
        // representation is a conservative heuristic, not a provider tokenizer.
        if (message.role === 'assistant' && message.continuation) {
            messageTokens += count(counter.countTokens(JSON.stringify(message.continuation)));
        }
        if (message.role === 'tool_result') {
            messageTokens += count(counter.countTokens(JSON.stringify({ toolCallId: message.toolCallId,
                ...(message.toolName === undefined ? {} : { toolName: message.toolName }) })));
        }
    }
    const toolTokens = input.tools?.length ? count(counter.countTokens(JSON.stringify({ tools: input.tools }))) : 0;
    const schemaTokens = input.responseSchema ? count(counter.countTokens(JSON.stringify(input.responseSchema))) : 0;
    const reservedOutputTokens = integer(input.reservedOutputTokens ?? 0, 'reservedOutputTokens');
    return { systemTokens, messageTokens, toolTokens, schemaTokens, reservedOutputTokens,
        totalTokens: systemTokens + messageTokens + toolTokens + schemaTokens + reservedOutputTokens };
}

/** Contributions remain ordinary PromptSections; no second registry or extension protocol. */
export async function collectPromptSections<T extends PromptContributionContext>(
    contributors: readonly IPromptContributor<T>[], context: T, signal?: AbortSignal,
): Promise<PromptSection[]> {
    const ids = new Set<string>();
    const sections: PromptSection[] = [];
    for (const contributor of contributors) {
        signal?.throwIfAborted();
        if (ids.has(contributor.id)) throw new Error(`Duplicate prompt contributor: ${contributor.id}`);
        ids.add(contributor.id);
        const contributed = await contributor.contribute(context);
        signal?.throwIfAborted();
        sections.push(...contributed);
    }
    return sections;
}

interface Group { messages: Message[]; firstIndex: number; unbound: boolean }
/** Dependency intervals also preserve interleaved result pairs, without rejecting partial continuations. */
function groups(messages: readonly Message[]): Group[] {
    const ends = messages.map((_, index) => index);
    const calls = new Map<string, number>();
    const unbound = new Set<number>();
    messages.forEach((message, index) => {
        if (message.role === 'assistant') for (const call of message.toolCalls ?? []) calls.set(call.id, index);
        if (message.role === 'tool_result') {
            const source = calls.get(message.toolCallId);
            if (source === undefined) unbound.add(index);
            else ends[source] = index;
        }
    });
    const unboundCount = [0];
    for (let index = 0; index < messages.length; index++) unboundCount.push(unboundCount[index] + (unbound.has(index) ? 1 : 0));
    const result: Group[] = [];
    for (let first = 0; first < messages.length;) {
        let end = ends[first];
        for (let index = first; index <= end; index++) end = Math.max(end, ends[index]);
        result.push({ messages: structuredClone(messages.slice(first, end + 1)), firstIndex: first,
            unbound: unboundCount[end + 1] > unboundCount[first] });
        first = end + 1;
    }
    return result;
}

/** Generic text compression preserves native image blocks and tool-result identity. */
export function compressToolResult(message: Message): Message | null {
    if (message.role !== 'tool_result') return null;
    const rich = message.contentBlocks?.length ? message.contentBlocks : undefined;
    const text = rich ? rich.filter(block => block.type === 'text').map(block => block.text).join('\n') : message.content;
    if (text.length <= 1200) return null;
    const marker = '\n… [truncated by context manager]';
    const result: ToolResultMessage = { ...message, content: text.slice(0, 400) + marker };
    if (rich) {
        let remaining = 400, marked = false;
        result.contentBlocks = rich.map(block => {
            if (block.type === 'image') return { ...block };
            const kept = block.text.slice(0, remaining);
            remaining -= kept.length;
            const suffix = remaining === 0 && !marked ? marker : '';
            if (suffix) marked = true;
            return { type: 'text' as const, text: kept + suffix };
        });
        result.content = result.contentBlocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
    }
    return result;
}
function protectedShape(message: Message): unknown {
    const { content: _content, ...metadata } = message;
    if (message.role !== 'tool_result') return metadata;
    return { ...metadata, ...(message.contentBlocks === undefined ? {} : {
        contentBlocks: message.contentBlocks.map(block => block.type === 'text' ? { type: 'text' } : block),
    }) };
}
const snapshotSection = snapshotPromptSection;

/** Contribute first, select/compress complete units, then render; history is never mutated. */
export async function composeAgentContext(input: ContextCompositionInput, options: ContextCompositionOptions = {}): Promise<ContextCompositionResult> {
    if (options.protectUserMessages !== undefined && !['latest', 'all'].includes(options.protectUserMessages)) throw new TypeError('Invalid human-message retention policy');
    const budget = integer(input.tokenBudget, 'tokenBudget', 1);
    const recent = integer(options.minRecentGroups ?? 2, 'minRecentGroups');
    input.signal?.throwIfAborted();
    const counter = options.tokenCounter ?? new HeuristicTokenCounter();
    const tokenOptions = { tokenCounter: counter, imageTokenEstimate: options.imageTokenEstimate };
    // Snapshot tools and section text once, so callbacks cannot change the accounting target.
    const tools = structuredClone(input.tools ?? []);
    const responseSchema = input.responseSchema ? structuredClone(input.responseSchema) : undefined;
    const system = input.system ?? '';
    const sections = (input.sections ?? []).map(snapshotSection);
    const sectionIds = new Set<string>();
    for (const section of sections) {
        if (sectionIds.has(section.id)) throw new Error(`Duplicate prompt section: ${section.id}`);
        sectionIds.add(section.id);
        section.estimatedTokens = count(counter.countTokens(section.text()));
    }
    const messageGroups = groups(input.messages);
    let currentUserIndex = -1;
    if (options.protectUserMessages === 'latest') input.messages.forEach((message, index) => {
        if (message.role === 'user' && (message.provenance ?? 'human') === 'human') currentUserIndex = index;
    });
    const presentMessages = (messages: readonly Message[]): Message[] => messages.map(message => {
        if (!options.includeToolCallIds || message.role !== 'tool_result') return message;
        const label = `${JSON.stringify({ toolCallId: message.toolCallId })}\n`;
        return { ...message, content: label + message.content,
            ...(message.contentBlocks ? { contentBlocks: [{ type: 'text' as const, text: label }, ...message.contentBlocks] } : {}) };
    });
    const groupTokens = (messages: readonly Message[]) => estimateContextTokens({ messages: presentMessages(messages) }, tokenOptions).messageTokens;
    const sourceText = messageGroups.flatMap(group => group.messages.map(message => message.content));
    type Item = { kind: 'messages'; group: Group; originalTokens: number; } | { kind: 'section'; section: PromptSection; };
    type Candidate = Item & { id: string; score: number; protected: boolean; action: ContextDecision['action']; reason?: ContextDecision['reason']; references?: ContextDecision['references']; order: number };
    const candidates: Candidate[] = sections.map((section, index) => ({ kind: 'section', section, id: section.id,
        score: sectionPriority(section),
        protected: sectionProtected(section), action: 'kept', order: index }));
    messageGroups.forEach((group, index) => {
        const score = options.scoreGroup?.(structuredClone(group.messages), index) ?? 0;
        if ((!Number.isFinite(score) && score !== Infinity)) throw new RangeError('Message group score must be finite or positive Infinity');
        const sticky = group.messages.some((message, offset) =>
            group.firstIndex + offset === currentUserIndex ||
            (options.protectUserMessages === 'all' && message.role === 'user' && (message.provenance ?? 'human') === 'human') ||
            (message.role === 'user' && message.sticky === true) ||
            options.protectMessage?.(structuredClone(message), group.firstIndex + offset));
        candidates.push({ kind: 'messages', group, originalTokens: groupTokens(group.messages), id: `messages:${group.firstIndex}`, score,
            protected: group.unbound || sticky || score === Infinity || index >= messageGroups.length - recent,
            action: 'kept', order: sections.length + index });
    });
    const render = (protectedOnly = false) => {
        const keptSections = candidates.filter((item): item is Candidate & { kind: 'section' } => item.kind === 'section' && item.action !== 'dropped' && (!protectedOnly || item.protected))
            .map(item => item.section);
        const rendered = renderPromptSections(keptSections);
        const finalSystem = [system, rendered.text].filter(Boolean).join('\n\n');
        // Ranges describe actual output, never pre-selection or pre-compression text.
        const systemSections: SystemSectionRange[] = [];
        let end = 0;
        if (system) { end = system.length; systemSections.push({ stability: 'retained', start: 0, end }); }
        for (const section of rendered.included) {
            const text = section.text();
            if (!text) continue;
            const start = end + (end ? 2 : 0);
            end = start + text.length;
            systemSections.push({ id: section.id, stability: section.stability ?? 'retained', start, end });
        }
        const messages = candidates.filter((item): item is Candidate & { kind: 'messages' } => item.kind === 'messages' && item.action !== 'dropped' && (!protectedOnly || item.protected))
            .flatMap(item => presentMessages(item.group.messages));
        const usage = estimateContextTokens({ system: finalSystem, messages, tools, responseSchema, reservedOutputTokens: input.reservedOutputTokens }, tokenOptions);
        return { system: finalSystem, systemSections, messages, includedSections: rendered.included, usage };
    };
    if (options.maxToolResultCharacters !== undefined) {
        integer(options.maxToolResultCharacters, 'maxToolResultCharacters', 1);
        if (!options.referenceToolResult) throw new TypeError('Tool output presentation requires referenceToolResult');
        for (const item of candidates) {
            if (item.kind !== 'messages') continue;
            for (const [offset, message] of item.group.messages.entries()) {
                input.signal?.throwIfAborted();
                if (message.role !== 'tool_result' || message.contentBlocks?.length || message.content.length <= options.maxToolResultCharacters) continue;
                const messageIndex = item.group.firstIndex + offset;
                const reference = options.referenceToolResult(structuredClone(message), messageIndex, structuredClone(tools));
                if (reference === null) continue;
                if (typeof reference !== 'string' || !reference.trim()) throw new ContextCompressionError('Tool result reference must be nonempty text or null');
                const content = projectToolOutput(message.content, reference, options.maxToolResultCharacters);
                if (content === null) continue;
                const before = render().usage.totalTokens;
                item.group.messages[offset] = { ...message, content };
                if (render().usage.totalTokens >= before) { item.group.messages[offset] = message; continue; }
                item.action = 'compressed';
                item.reason = 'presentation';
                (item.references ??= []).push({ messageIndex, reference, originalCharacters: message.content.length, retainedCharacters: content.length });
            }
        }
    }
    let result = render();
    const referenceResults = (item: Candidate & { kind: 'messages' }, protectedOnly = false) => {
        if (options.referenceToolResult) for (const [offset, message] of item.group.messages.entries()) {
            input.signal?.throwIfAborted();
            if ((protectedOnly ? render(true) : result).usage.totalTokens <= budget) break;
            if (message.role !== 'tool_result' || (!protectedOnly && message.isError) || message.contentBlocks?.length || message.content.length <= 1200) continue;
            const messageIndex = item.group.firstIndex + offset;
            const existing = item.references?.find(reference => reference.messageIndex === messageIndex);
            const reference = existing?.reference ?? options.referenceToolResult(structuredClone(message), messageIndex, structuredClone(tools));
            if (reference === null) continue;
            if (typeof reference !== 'string' || !reference.trim()) throw new ContextCompressionError('Tool result reference must be nonempty text or null');
            const content = protectedOnly ? projectToolOutput(message.content, reference, 1000) : `[Earlier tool result; exact saved text: ${reference}]\nPreview (not the full result):\n${sourceText[messageIndex].slice(0, 400)}`;
            if (content === null || content.length >= message.content.length) continue;
            item.group.messages[offset] = { ...message, content };
            const trial = render();
            if (trial.usage.totalTokens >= result.usage.totalTokens) { item.group.messages[offset] = message; continue; }
            result = trial;
            item.action = 'compressed';
            item.reason = 'budget';
            if (existing) existing.retainedCharacters = content.length;
            else (item.references ??= []).push({ messageIndex, reference, originalCharacters: message.content.length, retainedCharacters: content.length });
        }
    };
    // Protection retains the group; recoverable text can still need a preview to fit.
    for (const item of candidates) {
        if (render(true).usage.totalTokens <= budget) break;
        if (item.protected && item.kind === 'messages') referenceResults(item, true);
    }
    const minimum = render(true);
    if (minimum.usage.totalTokens > budget) throw new ContextBudgetExceededError(budget, minimum.usage.totalTokens, 'protected');
    const removable = candidates.filter(item => !item.protected).sort((left, right) => left.score - right.score || (left.kind === 'section' && right.kind === 'section' ? right.id.localeCompare(left.id) : left.order - right.order));
    for (const item of removable) {
        if (result.usage.totalTokens <= budget) break;
        input.signal?.throwIfAborted();
        if (item.kind === 'messages') {
            referenceResults(item);
            if (result.usage.totalTokens <= budget) break;
            const compressed: Message[] = [];
            const compressMessage = options.compressMessage ?? (options.referenceToolResult ? () => null : compressToolResult);
            for (const [offset, message] of item.group.messages.entries()) {
                const referenced = item.references?.some(reference => reference.messageIndex === item.group.firstIndex + offset);
                const replacement = referenced ? null : await compressMessage(structuredClone(message));
                input.signal?.throwIfAborted();
                if (replacement !== null && (!replacement || typeof replacement.content !== 'string' || !isDeepStrictEqual(protectedShape(message), protectedShape(replacement)))) {
                    throw new ContextCompressionError('Message compression may change text only; identity, provenance, protection, tool calls and media must remain unchanged');
                }
                compressed.push(replacement === null ? message : structuredClone(replacement));
            }
            const before = item.group.messages;
            item.group.messages = compressed;
            const trial = render();
            if (trial.usage.totalTokens < result.usage.totalTokens) { result = trial; item.action = 'compressed'; item.reason = 'budget'; }
            else item.group.messages = before;
        } else if (options.compressSection) {
            const compressed = await options.compressSection(snapshotSection(item.section));
            input.signal?.throwIfAborted();
            if (compressed !== null) {
                if (typeof compressed !== 'string') throw new ContextCompressionError('Section compressor must return text or null');
                const before = item.section;
                item.section = { ...before, text: () => compressed, estimatedTokens: count(counter.countTokens(compressed)) };
                const trial = render();
                if (trial.usage.totalTokens < result.usage.totalTokens) { result = trial; item.action = 'compressed'; item.reason = 'budget'; }
                else item.section = before;
            }
        }
    }
    for (const item of removable) {
        if (result.usage.totalTokens <= budget) break;
        item.action = 'dropped';
        item.reason = 'budget';
        result = render();
    }
    if (result.usage.totalTokens > budget) throw new ContextBudgetExceededError(budget, result.usage.totalTokens);
    input.signal?.throwIfAborted();
    for (const item of candidates.filter(item => item.action === 'dropped')) {
        if (item.kind === 'messages') for (const message of item.group.messages) options.onDrop?.(structuredClone(message));
        else options.onDropSection?.(snapshotSection(item.section));
    }
    return { ...result, tokenBudget: budget, messages: structuredClone(result.messages),
        excludedSections: candidates.filter((item): item is Candidate & { kind: 'section' } => item.kind === 'section' && item.action === 'dropped').map(item => item.section),
        decisions: candidates.map(item => ({ kind: item.kind, id: item.id, score: item.score, protected: item.protected, action: item.action,
            ...(item.reason ? { reason: item.reason } : {}),
            ...(item.kind === 'messages' ? { messageRange: { start: item.group.firstIndex, end: item.group.firstIndex + item.group.messages.length },
                tokens: { original: item.originalTokens, retained: item.action === 'dropped' ? 0 : groupTokens(item.group.messages) } } : {}),
            ...(item.references ? { references: item.references } : {}) })) };
}
