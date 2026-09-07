import { expect, it } from 'vitest';
import { readArchivedToolResult } from './ToolOutput.js';
import type { Message } from '../contracts/llm.js';

it('recovers complete saved text and source identities through either reference', () => {
    const content = 'a'.repeat(7999) + '🙂' + 'z'.repeat(8100);
    const history: Message[] = [{ role: 'user', content: 'task' },
        { role: 'tool_result', toolCallId: 'source-read', toolName: 'read_file', content }];
    const original = structuredClone(history);
    let offset = 0, restored = '';
    do {
        const page = readArchivedToolResult(history, { messageIndex: 1, offset });
        expect(page).toEqual(readArchivedToolResult(history, { callId: 'source-read', offset }));
        expect(page).toMatchObject({ messageIndex: 1, callId: 'source-read', toolName: 'read_file', totalCharacters: content.length });
        restored += page.content;
        offset = page.nextOffset;
        if (page.eof) break;
    } while (offset < content.length);
    expect(restored).toBe(content);
    expect(readArchivedToolResult(history, { messageIndex: 1, offset })).toMatchObject({ content: '', eof: true });
    expect(history).toEqual(original);
});

it('rejects invalid, ambiguous and non-tool references instead of guessing a source', () => {
    const history: Message[] = [{ role: 'user', content: 'task' },
        { role: 'tool_result', toolCallId: 'duplicate', content: 'first' },
        { role: 'tool_result', toolCallId: 'duplicate', content: 'second' }];
    for (const reference of [{}, { messageIndex: 1, callId: 'duplicate' }, { messageIndex: -1 },
        { messageIndex: 0 }, { messageIndex: 9 }, { callId: 'missing' }, { callId: 'duplicate' },
        { callId: '' }, { messageIndex: 1, offset: -1 }, { messageIndex: 1, offset: 6 }]) {
        expect(() => readArchivedToolResult(history, reference)).toThrow();
    }
    expect(readArchivedToolResult(history, { messageIndex: 2 }).content).toBe('second');
});
