import { LLMProtocolError } from '../contracts/llm.js';

/** Decode bounded SSE events and always dispose the stream, including on parser failure. */
export async function* sseData(response: Response): AsyncGenerator<string> {
    if (!response.body) throw new LLMProtocolError('Streaming response has no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            totalBytes += value?.byteLength ?? 0;
            if (totalBytes > 16 * 1024 * 1024) throw new LLMProtocolError('Response stream exceeds size limit');
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const blocks = buffer.split(/\r?\n\r?\n/);
            buffer = blocks.pop() ?? '';
            if (done && buffer.trim()) { blocks.push(buffer); buffer = ''; }
            for (const block of blocks) {
                if (block.length > 1024 * 1024) throw new LLMProtocolError('SSE event exceeds size limit');
                const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
                    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
                if (data) yield data;
            }
            if (buffer.length > 1024 * 1024) throw new LLMProtocolError('SSE event exceeds size limit');
            if (done) return;
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
