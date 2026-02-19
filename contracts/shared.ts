/**
 * Shared type definitions used across contracts.
 *
 * @module contracts
 */

/** Minimal JSON Schema type for tool input/output contracts. */
export type JsonSchema = {
    type: string;
    properties?: Record<string, JsonSchema>;
    items?: JsonSchema;
    required?: string[];
    description?: string;
    enum?: unknown[];
    [key: string]: unknown;
};
