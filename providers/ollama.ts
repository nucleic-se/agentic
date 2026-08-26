/**
 * Ollama provider — a thin OpenAI-compatible wrapper for Ollama's `/v1` API.
 */

import { OpenAICompatibleProvider, toOpenAIMessages, type OpenAICompatibleConfig } from './openai-compatible.js'
import type { ProviderCallOptions, StructuredRequest, StructuredResponse } from '../contracts/llm.js'
import type { RetryConfig } from './resilient-fetch.js'

export type OllamaReasoningEffort = 'none' | 'low' | 'medium' | 'high'

export interface OllamaConfig {
    /**
     * API key for Ollama Cloud. Falls back to AGENTIC_OLLAMA_API_KEY if omitted.
     * Not required for local Ollama instances.
     */
    apiKey?: string
    /** Chat model ID, e.g. `qwen3-coder:480b` or `deepseek-v3.1:671b`. */
    model: string
    /** Embedding model ID. Defaults to the chat model when omitted. */
    embeddingModel?: string
    /** Base URL including `/v1`. Falls back to AGENTIC_OLLAMA_BASE_URL, then the local default. */
    baseUrl?: string
    /**
     * Override the model's default context window size (in tokens).
     * Maps to Ollama's `options.num_ctx` in the request body.
     * Useful when the model's default is too small (e.g. gemma3 defaults to 8k).
     */
    numCtx?: number
    /**
     * Controls thinking on Ollama's OpenAI-compatible `/v1` API.
     * Use `none` to disable thinking, or `low`, `medium`, and `high` to
     * select a reasoning level on supported models.
     */
    reasoningEffort?: OllamaReasoningEffort
    /**
     * Extra fields merged into every chat completion request body.
     * Use for Ollama-specific options not covered by this config.
     * When `numCtx` is also set, `options.num_ctx` is merged in alongside
     * any `options` key provided here.
     */
    extraBody?: Record<string, unknown>
    /** Retry configuration for transient HTTP errors (429, 502, 503, 529). */
    retry?: RetryConfig
    /** Opt in to heuristic text-to-tool recovery for incompatible models. */
    recoverTextToolCalls?: boolean
}

export const OLLAMA_LOCAL_API_BASE = 'http://localhost:11434/v1'
export const OLLAMA_CLOUD_API_BASE = 'https://ollama.com/v1'

/**
 * Current cloud model defaults chosen from the live Ollama Cloud tags list.
 * Tier rationale:
 *   fast     — classify, acknowledge, summarize: tiny prompts (<1k tokens), 8k context ok
 *   balanced — respond (chat), plan, compress: needs ~6k grove context + chat history; must
 *              use a model with large native context since Ollama Cloud ignores num_ctx
 *   capable  — tool execution: needs best reasoning + tool calling
 */
export const OLLAMA_CLOUD_MODEL_DEFAULTS = {
    fast:     'gemma3:12b',
    balanced: 'glm-5:cloud',
    capable:  'deepseek-v3.1:671b',
} as const satisfies Record<'fast' | 'balanced' | 'capable', string>

export class OllamaProvider extends OpenAICompatibleProvider {
    constructor(config: OllamaConfig) {
        const extraBody: Record<string, unknown> = { ...config.extraBody }
        if (config.reasoningEffort != null && extraBody['reasoning_effort'] == null) {
            extraBody['reasoning_effort'] = config.reasoningEffort
        }
        if (config.numCtx != null) {
            extraBody['options'] = { num_ctx: config.numCtx, ...(extraBody['options'] as Record<string, unknown> | undefined) }
        }
        const baseConfig: OpenAICompatibleConfig = {
            apiKey:         config.apiKey ?? process.env['AGENTIC_OLLAMA_API_KEY'],
            model:          config.model,
            embeddingModel: config.embeddingModel,
            baseUrl:        config.baseUrl ?? process.env['AGENTIC_OLLAMA_BASE_URL'] ?? OLLAMA_LOCAL_API_BASE,
            providerName:   'OllamaProvider',
            retry:          config.retry,
            recoverTextToolCalls: config.recoverTextToolCalls,
            ...(Object.keys(extraBody).length > 0 ? { extraBody } : {}),
        }
        super(baseConfig)
    }

    /**
     * Override structured() to use json_object format instead of json_schema.
     * Ollama Cloud doesn't reliably support json_schema — many models ignore it
     * and return plain text. json_object works with schema in the prompt.
     */
    async structured<T>(request: StructuredRequest, options?: ProviderCallOptions): Promise<StructuredResponse<T>> {
        const schemaHint = `You MUST respond with ONLY a JSON object (no markdown, no code fences) matching this schema:\n${JSON.stringify(request.schema)}`
        // Use toOpenAIMessages to correctly map library roles (e.g. tool_result → tool)
        // before appending the schema hint as a final user message.
        const wireMessages = [
            ...toOpenAIMessages(request.system, request.messages),
            { role: 'user' as const, content: schemaHint },
        ]

        const res = await this.post<{
            choices?: Array<{ message?: { content?: string | null } }>
            usage?: { prompt_tokens?: number; completion_tokens?: number }
        }>('/chat/completions', {
            model:    this.model,
            messages: wireMessages,
            stream:   false,
            response_format: { type: 'json_object' },
            ...this.extraBody,
        }, options)

        const content = res.choices?.[0]?.message?.content
        if (!content) throw new Error('OllamaProvider: structured response was empty')

        // Strip code fences if model wraps the JSON.
        const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
        return {
            value: JSON.parse(cleaned) as T,
            usage: {
                inputTokens:  res.usage?.prompt_tokens ?? 0,
                outputTokens: res.usage?.completion_tokens ?? 0,
            },
        }
    }
}
