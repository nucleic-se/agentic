/** Only structured provider rejection codes establish a context overflow.
 * Generic HTTP errors and text mentioning token limits are not safe retry signals. */
export function isContextOverflowResponse(status: number, text: string): boolean {
    if (status !== 400 && status !== 413) return false;
    try {
        const body = JSON.parse(text);
        return body?.error?.code === 'context_length_exceeded';
    } catch { return false; }
}
