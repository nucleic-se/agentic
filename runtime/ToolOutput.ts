import type { Message, ToolResultMessage } from '../contracts/llm.js';
import type { ToolCallResult } from '../contracts/tool-runtime.js';

/** Read saved text with both source identities. The host supplies the authorized archive. */
export function readArchivedToolResult(history: readonly Message[], reference: { messageIndex?: number; callId?: string; offset?: number }) {
    if ((reference.messageIndex === undefined) === (reference.callId === undefined)) throw new Error('Provide exactly one of messageIndex or callId');
    if (reference.callId !== undefined && (typeof reference.callId !== 'string' || !reference.callId.trim())) throw new Error('Invalid saved call ID');
    if (reference.messageIndex !== undefined && (!Number.isSafeInteger(reference.messageIndex) || reference.messageIndex < 0)) throw new RangeError('Invalid saved message index');
    const offset = reference.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid saved result offset');
    const matches = reference.callId === undefined ? [reference.messageIndex!] : history.flatMap((message, index) =>
        message.role === 'tool_result' && message.toolCallId === reference.callId ? [index] : []);
    if (matches.length !== 1) throw new Error('Saved tool call is missing or ambiguous in this task');
    const messageIndex = matches[0], source = history[messageIndex];
    if (!source || source.role !== 'tool_result') throw new Error('Saved tool result does not exist in this task');
    if (offset > source.content.length) throw new RangeError('Offset exceeds saved result');
    const content = source.content.slice(offset, offset + 8000), nextOffset = offset + content.length;
    return { messageIndex, callId: source.toolCallId, toolName: source.toolName, totalCharacters: source.content.length,
        offset, nextOffset, eof: nextOffset === source.content.length, content };
}

/** Bounded presentation of retained text. Storage and retrieval belong to the host. */
export function projectToolOutput(text: string, reference: string, maxCharacters: number): string | null {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new RangeError('maxCharacters must be a positive safe integer');
    if (!reference.trim()) throw new TypeError('An exact-source reference is required');
    if (text.length <= maxCharacters) return null;
    const header = `[Tool output preview; exact saved text: ${reference}]\n`;
    // Reserve the longest possible omission marker, then keep complete UTF-16 characters.
    const room = maxCharacters - header.length - `\n[${text.length} UTF-16 code units omitted]\n`.length;
    if (room < 2) return null;
    let headEnd = Math.floor(room * 0.4), tailStart = text.length - (room - headEnd);
    const splitsPair = (at: number) => /[\uD800-\uDBFF]/.test(text[at - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[at] ?? '');
    if (splitsPair(headEnd)) headEnd--;
    if (splitsPair(tailStart)) tailStart++;
    return header + text.slice(0, headEnd) + `\n[${tailStart - headEnd} UTF-16 code units omitted]\n` + text.slice(tailStart);
}

/** Project a validated result without losing rich content. Hosts own storage and presentation limits. */
export function toToolResultMessage(call: { id: string; name?: string }, result: ToolCallResult): ToolResultMessage {
    return { role: 'tool_result', toolCallId: call.id, ...(call.name === undefined ? {} : { toolName: call.name }),
        content: result.content, isError: !result.ok,
        ...(result.contentBlocks ? { contentBlocks: structuredClone(result.contentBlocks) } : {}) };
}
