/** Deterministic context-selection evaluation. These oracles do not measure LLM task success. */
import type { Message } from '../../contracts/llm.js';
import { composeAgentContext, ContextBudgetExceededError, estimateContextTokens } from '../ContextPipeline.js';
import type { ContextCompositionInput, ContextCompositionOptions, ContextCompositionResult } from '../ContextPipeline.js';

export type ContextComposer = (input: ContextCompositionInput, options?: ContextCompositionOptions) => Promise<ContextCompositionResult>;
export interface ContextEvaluationCase {
    id: string;
    description: string;
    create(): { input: ContextCompositionInput; options?: ContextCompositionOptions };
    constraints?: readonly string[];
    evidence?: readonly string[];
    /** Atomic text fragments, all retained together or all omitted. */
    atomicGroups?: readonly (readonly string[])[];
    oracle?: { expected: string; answer(context: string): string | null };
    minimumCompressions?: number;
    expectProtectedOverflow?: boolean;
}
export interface ContextEvaluationResult {
    id: string;
    description: string;
    passed: boolean;
    checks: Record<string, boolean>;
    metrics: {
        inputEstimatedTokens: number;
        preparedEstimatedTokens: number | null;
        budget: number;
        constraintRetention: number | null;
        evidenceRetention: number | null;
        compressedItems: number;
        droppedItems: number;
        oraclePassed: boolean | null;
    };
    error?: string;
}
export interface ContextEvaluationReport {
    version: 1;
    kind: 'deterministic-context-retention';
    limitation: string;
    thresholds: { constraintRetention: 1; evidenceRetention: 1; budgetOverrun: 0; failedChecks: 0 };
    passed: boolean;
    cases: ContextEvaluationResult[];
}

const section = (id: string, text: string, priority: number, required = false) => ({
    id, text: () => text, priority, ...(required ? { phase: 'constraint' as const } : {}),
});
const noise = (count: number): Message[] => Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: `Unrelated archived discussion ${i}. ${'Background detail without current task evidence. '.repeat(12)}`,
}));
const question: Message = { role: 'user', content: 'Return the current route and access code.', sticky: true };
const constraint = 'Only use the current route and access code.';
const evidence = ['CURRENT_ROUTE=green', 'ACCESS_CODE=7421'];
const oracle = {
    expected: 'green:7421',
    answer(text: string): string | null {
        const route = /\bCURRENT_ROUTE=(\w+)/.exec(text)?.[1];
        const code = /\bACCESS_CODE=(\d+)/.exec(text)?.[1];
        return route && code ? `${route}:${code}` : null;
    },
};

/** Fresh fixtures ensure repeated runs and injected strategies cannot contaminate each other. */
export function contextEvaluationCases(): ContextEvaluationCase[] {
    return [
        ...[40, 400].map(length => ({
            id: `priority-over-recency-${length}`,
            description: `Current facts outrank ${length} noisy history messages; increasing history length must not change their importance.`,
            create: () => ({ input: { system: constraint, messages: [...noise(length), question],
                sections: [section('facts', evidence.join('\n'), 10)], tokenBudget: 700, reservedOutputTokens: 100 } }),
            constraints: [constraint], evidence, oracle,
        })),
        {
            id: 'atomic-source-group',
            description: 'A two-part optional source is omitted as one section while current evidence survives.',
            create: () => ({ input: { system: constraint, messages: [...noise(80), question], sections: [
                section('facts', evidence.join('\n'), 10),
                section('old-source', `OLD_SOURCE_HEADER\n${'archived detail '.repeat(1000)}\nOLD_SOURCE_FOOTER`, -10),
            ], tokenBudget: 400, reservedOutputTokens: 100 } }),
            constraints: [constraint], evidence, oracle,
            atomicGroups: [['OLD_SOURCE_HEADER', 'OLD_SOURCE_FOOTER'], evidence],
        },
        {
            id: 'compression-retains-evidence',
            description: 'An explicit deterministic compressor extracts current facts from a large section; the evidence oracle must still succeed.',
            create: () => ({ input: { system: constraint, messages: [question], sections: [section('large-source',
                `Source detail ${'noise '.repeat(3000)}\n${evidence.join('\n')}\n${'noise '.repeat(3000)}`, 10)], tokenBudget: 250, reservedOutputTokens: 100 },
                options: { compressSection: (source: { text(): string }) => source.text().split('\n').filter(line => /^(CURRENT_ROUTE|ACCESS_CODE)=/.test(line)).join('\n') } }),
            constraints: [constraint], evidence, oracle, minimumCompressions: 1,
        },
        {
            id: 'long-tool-history',
            description: 'Old tool exchanges are selected atomically; an interleaved current call/result interval survives intact.',
            create: () => {
                const messages: Message[] = [];
                for (let i = 0; i < 120; i++) messages.push(
                    { role: 'assistant', content: '', toolCalls: [{ id: `old-${i}`, name: 'read', args: { path: `old-${i}` } }] },
                    { role: 'tool_result', toolCallId: `old-${i}`, content: 'archived output '.repeat(100) });
                messages.push(
                    { role: 'assistant', content: '', toolCalls: [{ id: 'current', name: 'read', args: { path: 'current' } }] },
                    { role: 'user', content: 'INTERLEAVED_CURRENT_NOTE' },
                    { role: 'tool_result', toolCallId: 'current', content: evidence.join('\n') }, question);
                return { input: { system: constraint, messages, tokenBudget: 550, reservedOutputTokens: 100 } };
            },
            constraints: [constraint], evidence: [...evidence, 'INTERLEAVED_CURRENT_NOTE'], oracle,
        },
        {
            id: 'protected-overflow',
            description: 'Required context exceeding the ceiling is rejected explicitly, never silently truncated.',
            create: () => ({ input: { messages: [question], sections: [section('required', 'Required rule '.repeat(500), 0, true)],
                tokenBudget: 100, reservedOutputTokens: 40 } }),
            expectProtectedOverflow: true,
        },
    ];
}

function transmittedText(result: ContextCompositionResult): string {
    return [result.system, ...result.messages.map(message => message.role === 'tool_result' && message.contentBlocks?.length
        ? message.contentBlocks.filter(block => block.type === 'text').map(block => block.text).join('\n') : message.content)].join('\n');
}
function retention(markers: readonly string[] | undefined, text: string): number | null {
    return markers?.length ? markers.filter(marker => text.includes(marker)).length / markers.length : null;
}
/** Every complete original call/result pair must remain complete or be omitted together. */
function toolsIntact(original: readonly Message[], selected: readonly Message[]): boolean {
    const calls = (messages: readonly Message[]) => messages.flatMap(message => message.role === 'assistant' ? (message.toolCalls ?? []).map(call => call.id) : []);
    const results = (messages: readonly Message[]) => messages.flatMap(message => message.role === 'tool_result' ? [message.toolCallId] : []);
    const inputCalls = calls(original), inputResults = results(original), outputCalls = calls(selected), outputResults = results(selected);
    const seen = new Set<string>();
    for (const message of selected) {
        if (message.role === 'assistant') for (const call of message.toolCalls ?? []) {
            if (seen.has(call.id)) return false;
            seen.add(call.id);
        }
        if (message.role === 'tool_result' && !seen.has(message.toolCallId)) return false;
    }
    if (outputCalls.some(id => !inputCalls.includes(id)) || outputResults.some(id => !inputResults.includes(id))) return false;
    return inputCalls.every(id => {
        const expected = inputResults.filter(result => result === id).length;
        if (!expected) return true;
        const callCount = outputCalls.filter(call => call === id).length;
        const resultCount = outputResults.filter(result => result === id).length;
        return (callCount === 0 && resultCount === 0) || (callCount === 1 && resultCount === expected);
    });
}

export async function runContextEvaluation(
    cases: readonly ContextEvaluationCase[] = contextEvaluationCases(),
    compose: ContextComposer = composeAgentContext,
): Promise<ContextEvaluationReport> {
    if (!cases.length) throw new Error('An evaluation requires at least one case');
    if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('Evaluation case IDs must be unique');
    const results: ContextEvaluationResult[] = [];
    for (const item of cases) {
        const { input, options } = item.create();
        const originalMessages = structuredClone(input.messages);
        const inputSystem = [input.system, ...(input.sections ?? []).map(source => source.text())].filter(Boolean).join('\n\n');
        const inputEstimatedTokens = estimateContextTokens({ ...input, system: inputSystem }, options).totalTokens;
        const metrics: ContextEvaluationResult['metrics'] = { inputEstimatedTokens, preparedEstimatedTokens: null,
            budget: input.tokenBudget, constraintRetention: null, evidenceRetention: null, compressedItems: 0, droppedItems: 0, oraclePassed: null };
        let checks: Record<string, boolean> = {}, error: string | undefined;
        try {
            const result = await compose(input, options);
            const text = transmittedText(result);
            const measured = estimateContextTokens({ ...input, system: result.system, messages: result.messages }, options).totalTokens;
            metrics.preparedEstimatedTokens = measured;
            metrics.constraintRetention = retention(item.constraints, text);
            metrics.evidenceRetention = retention(item.evidence, text);
            metrics.compressedItems = result.decisions.filter(decision => decision.action === 'compressed').length;
            metrics.droppedItems = result.decisions.filter(decision => decision.action === 'dropped').length;
            metrics.oraclePassed = item.oracle ? item.oracle.answer(text) === item.oracle.expected : null;
            checks = {
                expectedOutcome: !item.expectProtectedOverflow,
                budget: measured <= input.tokenBudget,
                accounting: result.usage.totalTokens === measured,
                constraints: metrics.constraintRetention === null || metrics.constraintRetention === 1,
                evidence: metrics.evidenceRetention === null || metrics.evidenceRetention === 1,
                oracle: metrics.oraclePassed !== false,
                compression: metrics.compressedItems >= (item.minimumCompressions ?? 0),
                toolIntegrity: toolsIntact(originalMessages, result.messages),
                atomicGroups: (item.atomicGroups ?? []).every(group => { const count = group.filter(marker => text.includes(marker)).length; return count === 0 || count === group.length; }),
                sourceUnchanged: JSON.stringify(originalMessages) === JSON.stringify(input.messages),
            };
        } catch (failure) {
            const expected = item.expectProtectedOverflow === true && failure instanceof ContextBudgetExceededError;
            checks = { expectedOutcome: expected, sourceUnchanged: JSON.stringify(originalMessages) === JSON.stringify(input.messages) };
            if (!expected) error = failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);
        }
        results.push({ id: item.id, description: item.description, passed: Object.values(checks).every(Boolean), checks, metrics, ...(error ? { error } : {}) });
    }
    return { version: 1, kind: 'deterministic-context-retention',
        limitation: 'Synthetic evidence and answer oracles assess context retention only. No model is called; this is not an LLM task-success or semantic-summary-quality score.',
        thresholds: { constraintRetention: 1, evidenceRetention: 1, budgetOverrun: 0, failedChecks: 0 },
        passed: results.every(result => result.passed), cases: results };
}

export { runRetentionEvaluation } from './retention.js';
