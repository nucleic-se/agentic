import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectToolOutput, readTextPage } from '../ToolOutput.js';

export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const PREVIEW_CHARACTERS = 4000;

/** Host-owned saved text. IDs, rather than caller-supplied paths, select output. */
export class FileToolOutputStore {
    constructor(private readonly directory: string) {}
    async save(text: string): Promise<string> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const id = randomUUID();
        await writeFile(join(this.directory, id), text, { flag: 'wx', mode: 0o600 });
        return id;
    }
    async read(id: string, offset: number, signal?: AbortSignal) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid output ID');
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid output offset');
        signal?.throwIfAborted();
        const file = await open(join(this.directory, id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await file.stat();
            // UTF-8 replacement characters can expand the captured byte count up to threefold.
            if (!stat.isFile() || stat.size > MAX_CAPTURE_BYTES * 3) throw new Error('Invalid saved output file');
            const chunks: Buffer[] = [];
            const buffer = Buffer.alloc(8192);
            let bytes = 0;
            while (true) {
                signal?.throwIfAborted();
                const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                bytes += bytesRead;
                if (bytes > stat.size) throw new Error('Saved output grew during read');
                chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
            }
            const text = Buffer.concat(chunks).toString('utf8');
            if (offset > text.length) throw new Error('Offset exceeds saved output');
            return readTextPage(text, offset, 4000);
        } finally { await file.close(); }
    }
}

/** Capture is bounded independently of presentation. Overflow is explicitly incomplete. */
export class ToolOutputCapture {
    private chunks: Buffer[] = [];
    private capturedBytes = 0;
    private totalBytes = 0;
    append(data: Buffer) {
        this.totalBytes += data.length;
        const length = Math.min(data.length, MAX_CAPTURE_BYTES - this.capturedBytes);
        if (length > 0) { this.chunks.push(Buffer.from(data.subarray(0, length))); this.capturedBytes += length; }
    }
    async finish(store: FileToolOutputStore) {
        const text = Buffer.concat(this.chunks).toString('utf8');
        this.chunks = [];
        const incomplete = this.totalBytes > this.capturedBytes;
        const captureNotice = incomplete ? `\n[Capture incomplete: retained ${this.capturedBytes} of ${this.totalBytes} bytes]` : '';
        const metadata = { capturedBytes: this.capturedBytes, totalBytes: this.totalBytes, incomplete };
        if (text.length <= PREVIEW_CHARACTERS) return { content: text + captureNotice, ...metadata, truncated: false };
        try {
            const outputId = await store.save(text);
            return { content: projectToolOutput(text, `read_output({"id":"${outputId}","offset":0})`, PREVIEW_CHARACTERS)! + captureNotice,
                ...metadata, truncated: true, outputId };
        } catch (error) {
            // A storage error must not disguise the command's known exit status or promise retrieval.
            const preview = text.slice(0, 1600) + '\n[output truncated; full output unavailable]\n' + text.slice(-2200);
            return { content: preview + captureNotice, ...metadata, truncated: true, storageError: String(error) };
        }
    }
}
