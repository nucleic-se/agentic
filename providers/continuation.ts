import { createHash } from 'node:crypto';
import type { AssistantMessage, ProviderContinuation } from '../contracts/llm.js';
import type { JsonValue } from '../contracts/shared.js';

function contentHash(message: AssistantMessage): string {
    return createHash('sha256').update(JSON.stringify([message.content, message.toolCalls ?? []])).digest('hex');
}

/** Bind protocol annotations to exactly the message that produced them. */
export function createContinuation(message: AssistantMessage, format: string, identity: string, data: JsonValue): ProviderContinuation {
    return { format, identity, contentHash: contentHash(message), data: structuredClone(data) };
}

/** A changed message or backend must never accidentally replay stale protocol state. */
export function readContinuation(message: AssistantMessage, format: string, identity: string): JsonValue | undefined {
    const saved = message.continuation;
    if (saved?.format !== format || saved.identity !== identity || saved.contentHash !== contentHash(message)) return undefined;
    return structuredClone(saved.data);
}
