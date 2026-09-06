import type { ToolResultMessage } from '../contracts/llm.js';
import type { ToolCallResult } from '../contracts/tool-runtime.js';

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
