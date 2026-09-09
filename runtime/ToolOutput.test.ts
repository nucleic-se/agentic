import { expect, it } from 'vitest';
import { readArchivedToolResult, readTextPage } from './ToolOutput.js';
import type { Message } from '../contracts/llm.js';

it('pages at complete code-point boundaries with UTF-16 offsets', () => {
    const text = 'a😀bc';
    const first = readTextPage(text, 0, 2);
    expect(first).toMatchObject({ content: 'a', offset: 0, nextOffset: 1, eof: false });
    expect(Buffer.from(first.content, 'utf8').toString('utf8')).toBe(first.content);

    const second = readTextPage(text, first.nextOffset, 2);
    expect(second).toMatchObject({ content: '😀', offset: 1, nextOffset: 3, eof: false });
    expect(Buffer.from(second.content, 'utf8').toString('utf8')).toBe(second.content);
    expect(readTextPage(text, second.nextOffset, 2)).toMatchObject({ content: 'bc', nextOffset: 5, eof: true });
    expect(readTextPage(text, text.length, 1)).toMatchObject({ content: '', nextOffset: text.length, eof: true });

    expect(() => readTextPage(text, 2, 2)).toThrow('inside a surrogate pair');
    expect(() => readTextPage(text, 1, 1)).toThrow('too small for the next code point');
});

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
        expect(page.content.length).toBeLessThanOrEqual(8000);
        expect(Buffer.from(page.content, 'utf8').toString('utf8')).toBe(page.content);
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
