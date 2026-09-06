import { describe, expect, it } from 'vitest';
import { createContinuation, readContinuation } from './continuation.js';
import type { AssistantMessage } from '../contracts/llm.js';

describe('provider continuation', () => {
    it('survives serialization while rejecting edits and other backend identities', () => {
        const message: AssistantMessage = { role: 'assistant', content: 'Checking', toolCalls: [{ id: 'c', name: 'read', args: { path: 'a' } }] };
        message.continuation = createContinuation(message, 'fixture/v1', 'provider/api/model', { signature: 'opaque' });
        const restored: AssistantMessage = JSON.parse(JSON.stringify(message));
        expect(readContinuation(restored, 'fixture/v1', 'provider/api/model')).toEqual({ signature: 'opaque' });
        expect(readContinuation(restored, 'fixture/v2', 'provider/api/model')).toBeUndefined();
        expect(readContinuation(restored, 'fixture/v1', 'provider/api/other')).toBeUndefined();
        restored.toolCalls![0].args.path = 'b';
        expect(readContinuation(restored, 'fixture/v1', 'provider/api/model')).toBeUndefined();
        expect(readContinuation({ ...message, content: 'Changed' }, 'fixture/v1', 'provider/api/model')).toBeUndefined();
    });
    it('does not alias caller or restored annotation data', () => {
        const message: AssistantMessage = { role: 'assistant', content: '' };
        const data = { signature: 'original' };
        message.continuation = createContinuation(message, 'v1', 'backend', data);
        data.signature = 'changed';
        const read = readContinuation(message, 'v1', 'backend') as typeof data;
        read.signature = 'also changed';
        expect(readContinuation(message, 'v1', 'backend')).toEqual({ signature: 'original' });
    });
});
