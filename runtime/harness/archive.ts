import { z } from 'zod';
import type { Message, ToolDefinition, ToolResultMessage } from '../../contracts/llm.js';
import type { IValidatedToolRuntime, ToolCallValidation } from '../../contracts/tool-runtime.js';
import { readArchivedToolResult } from '../ToolOutput.js';

const archivedToolResultSchema = z.union([
    z.object({ callId: z.string().trim().min(1).max(1000), offset: z.number().int().nonnegative().optional() }).strict(),
    z.object({ messageIndex: z.number().int().nonnegative(), offset: z.number().int().nonnegative().optional() }).strict(),
]);

const definition: ToolDefinition = {
    name: 'read_tool_result', description: 'Read exact saved tool-result text from this session by callId or original messageIndex. Returns at most 8000 UTF-16 code units; use nextOffset until eof. This reads historical evidence and never reruns the tool.',
    parameters: { ...z.toJSONSchema(archivedToolResultSchema), type: 'object' } as ToolDefinition['parameters'],
};
export function archivedToolResultDefinition(): ToolDefinition { return structuredClone(definition); }
export function validateArchivedToolResult(args: Record<string, unknown>): ToolCallValidation {
    if ((args.callId === undefined) === (args.messageIndex === undefined))
        return { ok: false, result: { ok: false, content: 'Provide exactly one of messageIndex or callId', errorKind: 'validation' } };
    const parsed = archivedToolResultSchema.safeParse(args);
    return parsed.success ? { ok: true, args: parsed.data } : { ok: false, result: { ok: false, content: parsed.error.message, errorKind: 'validation' } };
}

/** Reference original results only when the composition can retrieve them. Never shorten a retrieval page recursively. */
export function archivedToolResultReference(message: ToolResultMessage, _index: number, tools: readonly ToolDefinition[]): string | null {
    return !['read_tool_result', 'read_output'].includes(message.toolName ?? '') && tools.some(tool => tool.name === 'read_tool_result')
        ? `read_tool_result(${JSON.stringify({ callId: message.toolCallId, offset: 0 })})` : null;
}

/** The host supplies only the current session's original transcript. */
export function archiveToolRuntime(read: (sessionId: string, signal?: AbortSignal) => Promise<readonly Message[]>): IValidatedToolRuntime {
    const runtime: IValidatedToolRuntime = {
        effectFor: name => name === 'read_tool_result' ? 'read' : undefined,
        tools: () => [archivedToolResultDefinition()],
        validate(name, args) {
            if (name !== 'read_tool_result') return { ok: false, result: { ok: false, content: 'Unknown archive tool', errorKind: 'validation' } };
            return validateArchivedToolResult(args);
        },
        async call(name, args, options) {
            const checked = runtime.validate(name, args);
            if (!checked.ok) return checked.result;
            if (!options?.sessionId) return { ok: false, content: 'Archive access requires a host session', errorKind: 'validation' };
            try {
                options.signal?.throwIfAborted();
                const history = await read(options.sessionId, options.signal);
                options.signal?.throwIfAborted();
                return { ok: true, content: JSON.stringify(readArchivedToolResult(history, checked.args)) };
            } catch (error) {
                return { ok: false, content: error instanceof Error ? error.message : String(error), errorKind: options.signal?.aborted ? 'cancelled' : 'runtime' };
            }
        },
    };
    return runtime;
}
