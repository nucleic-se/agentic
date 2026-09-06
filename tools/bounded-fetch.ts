/** Fetch headers and a bounded body under one deadline. */
export async function boundedFetch(url: string, init: RequestInit = {}, maxBytes = 128 * 1024): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('HTTP request timed out')), 15_000);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
        const response = await fetch(url, { ...init, signal });
        if (!response.body) return { response, text: '' };
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        let truncated = false;
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const remaining = maxBytes - size;
                chunks.push(value.subarray(0, remaining));
                size += Math.min(value.byteLength, remaining);
                if (value.byteLength > remaining) { truncated = true; break; }
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        return { response, text: Buffer.concat(chunks).toString('utf8') + (truncated ? '\n[truncated]' : '') };
    } finally {
        clearTimeout(timer);
    }
}
