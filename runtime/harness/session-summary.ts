import type { SessionSummary } from './types.js';

/** List views never carry conversations, tool arguments or execution receipts. */
export function sessionSummary(record: SessionSummary): SessionSummary {
    const { id, title, revision, createdAt, updatedAt, status } = record;
    return { id, title, revision, createdAt, updatedAt, status };
}
