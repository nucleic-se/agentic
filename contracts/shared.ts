/**
 * Shared type definitions used across contracts.
 *
 * @module contracts
 */

/** Serializable data shared across adapters and persistence. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

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
