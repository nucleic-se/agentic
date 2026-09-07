import { expect, it } from 'vitest';
import { z } from 'zod';
import { checkpointFromResponse, checkpointRequest, type CheckpointFormat } from './checkpoint.js';
import { checkpointContextLifecycle, type ContextMaintenance } from './context-lifecycle.js';
import { createHarnessExecution } from './execution.js';
import { budgetedContext } from './defaults.js';
import type { Message, TurnResponse } from '../../contracts/llm.js';

const schema = z.object({ observations: z.array(z.string()).max(4), unfinished: z.array(z.string()).max(4) }).strict();
const format: CheckpointFormat = {
    instructions: 'Return the replacement using checkpoint_state. Preserve observations and unfinished work.',
    tools: [{ name: 'checkpoint_state', description: 'Record derived state', parameters: z.toJSONSchema(schema) }],
    decode(response) {
        const calls = response.message.toolCalls ?? [];
        if (response.stopReason !== 'tool_use' || calls.length !== 1 || calls[0].name !== 'checkpoint_state') return { ok: false, reason: 'invalid_format' };
        const parsed = schema.safeParse(calls[0].args);
        return parsed.success ? { ok: true, text: JSON.stringify(parsed.data) } : { ok: false, reason: 'invalid_format' };
    },
};
const response = (args: Record<string, unknown>): TurnResponse => ({ message: { role: 'assistant', content: '', toolCalls: [{ id: 'state', name: 'checkpoint_state', args }] }, stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } });
const value = { observations: ['Source inspected.'], unfinished: ['Security verification.'] };
function fixture() {
    const messages: Message[] = [{ role: 'user', content: 'Do not release before security verification.' },
        ...Array.from({ length: 40 }, (_, i) => ({ role: 'assistant' as const, content: `Evidence ${i}: ${'detail '.repeat(45)}` }))];
    const execution = createHarnessExecution({ context: budgetedContext('', 3000), provider: {
        turn: async () => { throw new Error('No provider dispatch during preparation'); }, structured: async () => { throw new Error('unused'); },
    } });
    return { request: { messages, maxTokens: 64 }, execution };
}

it('decodes structured state without allowing incomplete responses or mutating their receipts', () => {
    const original = response(value), selection = { through: 2 };
    expect(checkpointFromResponse(selection, original, format)).toEqual({ ok: true, checkpoint: { through: 2, text: JSON.stringify(value) } });
    expect(checkpointFromResponse(selection, { ...original, stopReason: 'max_tokens' }, format)).toEqual({ ok: false, reason: 'incomplete' });
    expect(checkpointFromResponse(selection, response({ observations: 'invalid' }), format)).toEqual({ ok: false, reason: 'invalid_format' });
    const before = structuredClone(original);
    checkpointFromResponse(selection, original, { ...format, decode(copy) { copy.message.content = 'changed'; return { ok: true, text: 'state' }; } });
    expect(original).toEqual(before);
});

it('preserves structured rejection data and format across repair and serialized resume', async () => {
    const { request, execution } = fixture(), original = structuredClone(request);
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, format });
    const step = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    expect(step.kind).toBe('maintenance');
    expect(step.prepared.request.tools).toEqual(format.tools);
    const bad = response({ observations: 'invalid', unfinished: ['Security verification.'] });
    const rejected = step.reduce(bad);
    const state = JSON.parse(JSON.stringify(rejected.state));
    const repair = await lifecycle.prepare({ request, state }, execution) as ContextMaintenance;
    expect(repair.prepared.request.tools).toEqual(format.tools);
    expect(repair.prepared.request.system).toContain(format.instructions);
    const input = JSON.parse(repair.prepared.request.messages[0].content);
    expect(JSON.parse(input.draft).toolCalls).toEqual(bad.message.toolCalls);
    expect(input.requirements).toEqual([{ index: 0, content: request.messages[0].content }]);
    expect(repair.metadata.sourceRange).toEqual(step.metadata.sourceRange);
    const candidate = repair.reduce(response(value));
    const next = await lifecycle.prepare({ request, state: JSON.parse(JSON.stringify(candidate.state)) }, execution);
    expect(next.kind).toBe('task');
    expect(next.prepared.request.messages.some(m => m.content.includes(JSON.stringify(value)))).toBe(true);
    const secondFailure = repair.reduce(bad);
    await expect(lifecycle.prepare({ request, state: JSON.parse(JSON.stringify(secondFailure.state)) }, execution)).rejects.toThrow('after two attempts');
    expect(request).toEqual(original);
});

it('admits rendered structured state against the actual context budget before accepting it', async () => {
    const { request: base, execution } = fixture();
    const request = { ...base, system: 'Policy '.repeat(500) };
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, format });
    const step = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    const large = { observations: ['x'.repeat(9000)], unfinished: ['Security verification.'] };
    const pending = step.reduce(response(large));
    const repair = await lifecycle.prepare({ request, state: pending.state }, execution) as ContextMaintenance;
    expect(repair.metadata.rejection).toBe('too_large');
    expect(repair.prepared.request.tools).toEqual(format.tools);
    expect(JSON.parse(repair.prepared.request.messages[0].content).draft).toBe(JSON.stringify(large));
});

it('keeps request schemas independent and snapshots the format at composition time', async () => {
    const { request, execution } = fixture();
    const configured = { ...format, tools: structuredClone([...format.tools!]) };
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, format: configured });
    configured.instructions = 'changed'; configured.tools[0].name = 'changed';
    const step = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    expect(step.prepared.request.system).toContain(format.instructions);
    expect(step.prepared.request.tools).toEqual(format.tools);
    const generated = checkpointRequest(request.messages, 2, { format });
    generated.tools[0].name = 'changed';
    expect(format.tools![0].name).toBe('checkpoint_state');
});

it('keeps the response format and exact cursor through oversized source chunks', async () => {
    const { request, execution } = fixture();
    request.messages.splice(1, 0, { role: 'assistant', content: 'large evidence🙂 '.repeat(8000) });
    const original = structuredClone(request.messages);
    const lifecycle = checkpointContextLifecycle({ maxTokens: 64, format });
    const first = await lifecycle.prepare({ request }, execution) as ContextMaintenance;
    const input = JSON.parse(first.prepared.request.messages[0].content);
    expect(input.sourceChunk.offset).toBe(0);
    expect(first.prepared.request.tools).toEqual(format.tools);
    const candidate = first.reduce(response(value));
    const next = await lifecycle.prepare({ request, state: JSON.parse(JSON.stringify(candidate.state)) }, execution) as ContextMaintenance;
    const continued = JSON.parse(next.prepared.request.messages[0].content);
    expect(continued.sourceChunk.offset).toBe(input.sourceChunk.endOffset);
    expect(next.prepared.request.tools).toEqual(format.tools);
    expect(next.prepared.request.system).toContain(format.instructions);
    expect(continued.requirements).toEqual(input.requirements);
    expect(request.messages).toEqual(original);
});
