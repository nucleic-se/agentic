import { z } from 'zod';

export const workspaceFilePath = z.string().min(1).describe('Path relative to the workspace, or an absolute path inside it.');
export const fsReadSchema = z.union([
    z.object({ path: workspaceFilePath, encoding: z.literal('utf8').optional(), mode: z.literal('lines').optional(),
        offset: z.number().int().min(1).optional().describe('First line, numbered from 1. Default: 1.'),
        limit: z.number().int().positive().optional().describe('Maximum lines. Default: 200; byte ceiling still applies.') }).strict(),
    z.object({ path: workspaceFilePath, encoding: z.literal('utf8').optional(), mode: z.literal('bytes'),
        offset: z.number().int().nonnegative().optional().describe('Byte offset, starting at 0. Default: 0.'),
        limit: z.number().int().min(1).max(16000).optional().describe('Maximum UTF-8 bytes. Default: 16000.') }).strict(),
    z.object({ path: workspaceFilePath, encoding: z.literal('base64'), mode: z.literal('lines').optional() }).strict(),
]);
export const fsWriteSchema = z.object({ path: workspaceFilePath,
    content: z.string().max(262144).describe('Text to write, at most 262144 UTF-8 bytes.').refine(text => Buffer.byteLength(text, 'utf8') <= 262144, 'Content exceeds 262144 UTF-8 bytes'),
    append: z.boolean().optional(),
}).strict();
