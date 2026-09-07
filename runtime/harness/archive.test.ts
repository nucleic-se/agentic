import { expect, it, vi } from 'vitest';
import { archiveToolRuntime } from './archive.js';
import { defaultCodingPolicy } from './defaults.js';

it('pages exact current-session sources and rejects model-supplied session identities', async () => {
    const content = 'source evidence '.repeat(1300);
    const read = vi.fn(async () => [{ role: 'tool_result' as const, toolCallId: 'opaque', content }]);
    const runtime = archiveToolRuntime(read);
    let recovered = '', offset = 0;
    do {
        const result = await runtime.call('read_tool_result', { callId: 'opaque', offset }, { sessionId: 'host-owned' });
        expect(result.ok).toBe(true);
        const page = JSON.parse(result.content);
        expect(page.content.length).toBeLessThanOrEqual(8000);
        recovered += page.content;
        offset = page.nextOffset;
        if (page.eof) break;
    } while (offset < content.length);
    expect(recovered).toBe(content);
    expect(read).toHaveBeenCalledWith('host-owned', undefined);
    const calls = read.mock.calls.length;
    expect((await runtime.call('read_tool_result', { callId: 'opaque', sessionId: 'other' }, { sessionId: 'host-owned' })).ok).toBe(false);
    expect((await runtime.call('read_tool_result', { callId: 'opaque' })).ok).toBe(false);
    expect(read).toHaveBeenCalledTimes(calls);
    expect((await runtime.call('read_tool_result', { messageIndex: 0 }, { sessionId: 'host-owned' })).ok).toBe(true);
    expect((await runtime.call('read_tool_result', { callId: 'missing' }, { sessionId: 'host-owned' })).ok).toBe(false);
});
it('allows archive reads under the default coding policy', async () => {
    expect(await defaultCodingPolicy().evaluate({ name: 'read_tool_result', args: { callId: 'a' } })).toEqual({ kind: 'allow' });
});
