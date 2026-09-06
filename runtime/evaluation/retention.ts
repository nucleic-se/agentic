/** Controlled retention fixtures: exact-source recovery and request size, not agent intelligence. */
import { isDeepStrictEqual } from 'node:util';
import { composeAgentContext } from '../ContextPipeline.js';
import type { Message, ToolDefinition } from '../../contracts/llm.js';

const retrieval: ToolDefinition = { name: 'read_saved', description: 'Read original tool text by message index.',
    parameters: { type: 'object', properties: { messageIndex: { type: 'integer' } }, required: ['messageIndex'] } };

export function retentionFixture() {
    const answer = 'ARCHIVE-7421';
    const messages: Message[] = [{ role: 'user', content: 'Find the exact archive code in source zero.', sticky: true }];
    for (let index = 0; index < 4; index++) messages.push(
        { role: 'assistant', content: '', toolCalls: [{ id: `source-${index}`, name: 'read_source', args: { index } }] },
        { role: 'tool_result', toolCallId: `source-${index}`, toolName: 'read_source',
            content: `Source ${index}\n${'ordinary source material '.repeat(200)}\n${index === 0 ? `ARCHIVE_CODE=${answer}` : 'No archive code in this source.'}` },
    );
    messages.push({ role: 'user', content: 'Now return only the archive code. Use saved evidence if needed.', sticky: true });
    return { answer, messages, tools: [retrieval] };
}

export async function runRetentionEvaluation() {
    const cases = [];
    for (const budget of [20000, 2400]) for (const mode of ['full', 'recoverable', 'no-grant'] as const) {
        const fixture = retentionFixture(), original = structuredClone(fixture.messages);
        const tools = mode === 'no-grant' ? [] : fixture.tools;
        const result = await composeAgentContext({ system: 'Use only supplied evidence.', messages: fixture.messages,
            tools, tokenBudget: budget, reservedOutputTokens: 100 }, {
            // Keep source zero important, but still eligible for reference retention.
            scoreGroup: messages => messages.some(message => message.role === 'tool_result' && message.toolCallId === 'source-0') ? 10 : 0,
            compressMessage: () => null,
            ...(mode === 'full' ? {} : { referenceToolResult: (_message: Message, index: number, granted: readonly ToolDefinition[]) =>
                granted.some(tool => tool.name === retrieval.name) ? `read_saved(${index})` : null }),
        });
        const selected = result.messages.map(message => message.content).join('\n');
        let answer = /ARCHIVE_CODE=(\S+)/.exec(selected)?.[1] ?? null;
        let retrievals = 0;
        let exactReferences = true;
        const references = result.decisions.filter(decision => decision.action !== 'dropped').flatMap(decision => decision.references ?? []);
        for (const reference of references) {
            const source = original[reference.messageIndex];
            const visible = result.messages.some(message => message.role === 'tool_result' && source?.role === 'tool_result' &&
                message.toolCallId === source.toolCallId && message.content.includes(reference.reference));
            const valid = source?.role === 'tool_result' && source.content.length === reference.originalCharacters &&
                reference.reference === `read_saved(${reference.messageIndex})` && visible;
            exactReferences &&= valid;
            if (!answer && valid) {
                retrievals++;
                answer = /ARCHIVE_CODE=(\S+)/.exec(source.content)?.[1] ?? null;
            }
        }
        const calls = result.messages.flatMap(message => message.role === 'assistant' ? message.toolCalls ?? [] : []);
        const outputs = result.messages.filter(message => message.role === 'tool_result');
        const checks = {
            sourceUnchanged: isDeepStrictEqual(fixture.messages, original),
            budgetRespected: result.usage.totalTokens <= budget,
            pairedTools: calls.every(call => outputs.some(output => output.toolCallId === call.id)) && outputs.every(output => calls.some(call => call.id === output.toolCallId)),
            exactReferences,
            grantsRespected: mode !== 'no-grant' || references.length === 0,
            recoverableAnswer: mode !== 'recoverable' || answer === fixture.answer,
        };
        cases.push({ id: `${mode}-${budget}`, mode, budget, checks, passed: Object.values(checks).every(Boolean),
            preparedEstimatedTokens: result.usage.totalTokens, references: references.length, retrievals,
            answerAvailable: answer === fixture.answer, droppedGroups: result.decisions.filter(decision => decision.action === 'dropped').length });
    }
    return { version: 1, kind: 'paired-recoverable-context', passed: cases.every(test => test.passed),
        limitation: 'A deterministic oracle follows retained source references. This measures recoverability and request size, not model selection, retrieval cost or end-to-end task quality.', cases };
}
