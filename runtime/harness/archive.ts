import { z } from 'zod';
import type { Message } from '../../contracts/llm.js';
import type { IValidatedToolRuntime } from '../../contracts/tool-runtime.js';
import { readArchivedToolResult } from '../ToolOutput.js';

const schema = z.object({
    callId: z.string().min(1).optional(), messageIndex: z.number().int().nonnegative().optional(),
    offset: z.number().int().nonnegative().optional(),
}).strict().refine(value => (value.callId === undefined) !== (value.messageIndex === undefined), 'Provide exactly one of callId or messageIndex');

/** The host supplies only the current session's original transcript. */
export function archiveToolRuntime(read: (sessionId: string, signal?: AbortSignal) => Promise<readonly Message[]>): IValidatedToolRuntime {
    const runtime: IValidatedToolRuntime = {
        tools: () => [{ name: 'read_tool_result', description: 'Read exact saved tool-result text from this session by callId or original messageIndex. Returns at most 8000 UTF-16 code units; use nextOffset until eof. This reads historical evidence and never reruns the tool.',
            parameters: z.toJSONSchema(schema) as ReturnType<IValidatedToolRuntime['tools']>[number]['parameters'] }],
        validate(name, args) {
            if (name !== 'read_tool_result') return { ok: false, result: { ok: false, content: 'Unknown archive tool', errorKind: 'validation' } };
            const parsed = schema.safeParse(args);
            return parsed.success ? { ok: true, args: parsed.data } : { ok: false, result: { ok: false, content: parsed.error.message, errorKind: 'validation' } };
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
