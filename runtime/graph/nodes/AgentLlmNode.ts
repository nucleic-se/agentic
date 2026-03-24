/**
 * Agent LLM node — purpose-built graph node for agentic turn interactions.
 *
 * Unlike LlmGraphNode (simple prompt→text/structured), this node handles
 * the full agent LLM interaction:
 *
 * - Reads system prompt + message history from configurable state keys
 * - Calls provider.turn() with tool definitions
 * - Writes the full AssistantMessage (including toolCalls[]) to state
 * - Reports token usage via context.reportTokens()
 * - Emits typed events to a state key
 * - Accepts an onError callback for error cascade integration
 * - Provider can be static or dynamic (state-dependent selection)
 *
 * @module runtime/graph/nodes
 */

import type {
    ILLMProvider,
    TurnRequest,
    TurnResponse,
    AssistantMessage,
    Message,
    ToolDefinition,
    TokenUsage,
} from '../../../contracts/llm.js';
import type {
    GraphState,
    GraphContext,
    IGraphNode,
} from '../../../contracts/graph/IGraphEngine.js';

// ── Event types emitted by AgentLlmNode ──────────────────────

export interface AgentLlmTurnStartEvent {
    type: 'turn_start';
    nodeId: string;
    timestamp: number;
}

export interface AgentLlmTurnEndEvent {
    type: 'turn_end';
    nodeId: string;
    message: AssistantMessage;
    usage: TokenUsage;
    stopReason: string;
    timestamp: number;
}

export interface AgentLlmMessageDeltaEvent {
    type: 'message_delta';
    nodeId: string;
    text: string;
    timestamp: number;
}

export type AgentLlmEvent =
    | AgentLlmTurnStartEvent
    | AgentLlmTurnEndEvent
    | AgentLlmMessageDeltaEvent;

// ── Error callback ───────────────────────────────────────────

export type OnErrorAction = 'retry' | 'continue' | 'fail';

export type AgentLlmOnError<TState extends GraphState> = (
    error: Error,
    state: TState,
    context: GraphContext<TState>,
) => OnErrorAction | Promise<OnErrorAction>;

// ── Config ───────────────────────────────────────────────────

export interface AgentLlmNodeConfig<TState extends GraphState> {
    /** Unique node ID. */
    id: string;

    /**
     * LLM provider — static instance or dynamic selector.
     * Dynamic form enables error cascade to switch tiers mid-run:
     *   (state) => router.select(state.fallbackActive ? 'balanced' : 'capable')
     */
    provider: ILLMProvider | ((state: Readonly<TState>) => ILLMProvider);

    /** State key containing the system prompt string. */
    systemPromptKey: keyof TState & string;

    /** State key containing the Message[] array. */
    messagesKey: keyof TState & string;

    /** State key to write the AssistantMessage response to. */
    outputKey: keyof TState & string;

    /**
     * Tool definitions — static array, or function that reads from state.
     * If omitted, no tools are passed to the provider.
     */
    tools?: ToolDefinition[] | ((state: Readonly<TState>) => ToolDefinition[]);

    /**
     * State key to append AgentLlmEvent objects to.
     * If omitted, events are not emitted to state.
     */
    eventsKey?: keyof TState & string;

    /**
     * Error callback for error cascade integration.
     * Called when provider.turn() throws. Returns a routing decision:
     *   'retry'    — retry the call (callback should mutate state first, e.g. switch model tier)
     *   'continue' — skip the error, proceed to next node with current state
     *   'fail'     — re-throw the error (default if no callback)
     *
     * Max retries controlled by maxRetries config (default 0).
     */
    onError?: AgentLlmOnError<TState>;

    /** Max retries when onError returns 'retry'. Default: 3. */
    maxRetries?: number;

    /** Max tokens to generate. Passed to TurnRequest.maxTokens. */
    maxTokens?: number;
}

// ── Node implementation ──────────────────────────────────────

export class AgentLlmNode<TState extends GraphState = GraphState>
    implements IGraphNode<TState>
{
    readonly id: string;
    private readonly config: AgentLlmNodeConfig<TState>;

    constructor(config: AgentLlmNodeConfig<TState>) {
        this.id = config.id;
        this.config = config;
    }

    async process(state: TState, context: GraphContext<TState>): Promise<void> {
        const {
            provider: providerOrFn,
            systemPromptKey,
            messagesKey,
            outputKey,
            tools: toolsOrFn,
            eventsKey,
            onError,
            maxRetries = 3,
            maxTokens,
        } = this.config;

        // Resolve provider (static or dynamic)
        const provider: ILLMProvider = typeof providerOrFn === 'function'
            ? providerOrFn(state)
            : providerOrFn;

        // Read state
        const systemPrompt = state[systemPromptKey] as string | undefined;
        const messages = state[messagesKey] as Message[];
        const tools = typeof toolsOrFn === 'function'
            ? toolsOrFn(state)
            : toolsOrFn;

        // Build request
        const request: TurnRequest = {
            messages,
            ...(systemPrompt && { system: systemPrompt }),
            ...(tools && tools.length > 0 && { tools }),
            ...(maxTokens != null && { maxTokens }),
        };

        // Emit turn_start
        this.emitEvent(state, eventsKey, {
            type: 'turn_start',
            nodeId: this.id,
            timestamp: Date.now(),
        });

        // Call LLM with error cascade support
        let response: TurnResponse;
        let attempts = 0;

        while (true) {
            try {
                // Use streaming if available for delta events
                if (eventsKey && provider.streamTurn) {
                    response = await provider.streamTurn(request, (text) => {
                        this.emitEvent(state, eventsKey, {
                            type: 'message_delta',
                            nodeId: this.id,
                            text,
                            timestamp: Date.now(),
                        });
                    });
                } else {
                    response = await provider.turn(request);
                }
                break; // success
            } catch (error) {
                if (!onError || attempts >= maxRetries) {
                    throw error;
                }

                const action = await onError(error as Error, state, context);

                if (action === 'retry') {
                    attempts++;
                    // Re-resolve provider in case onError mutated state (e.g. fallbackActive)
                    const retryProvider: ILLMProvider = typeof providerOrFn === 'function'
                        ? providerOrFn(state)
                        : providerOrFn;

                    // Rebuild request in case state changed
                    const retrySystem = state[systemPromptKey] as string | undefined;
                    const retryMessages = state[messagesKey] as Message[];
                    request.messages = retryMessages;
                    if (retrySystem) request.system = retrySystem;

                    // Use the potentially-new provider on next iteration
                    Object.defineProperty(request, '__provider', { value: retryProvider });
                    continue;
                } else if (action === 'continue') {
                    return; // Skip — node completes without writing output
                } else {
                    throw error; // 'fail' or unknown
                }
            }
        }

        // Write response to state
        (state as Record<string, unknown>)[outputKey] = response.message;

        // Report token usage
        const totalTokens = response.usage.inputTokens + response.usage.outputTokens;
        context.reportTokens(totalTokens);

        // Emit turn_end
        this.emitEvent(state, eventsKey, {
            type: 'turn_end',
            nodeId: this.id,
            message: response.message,
            usage: response.usage,
            stopReason: response.stopReason,
            timestamp: Date.now(),
        });
    }

    private emitEvent(
        state: TState,
        eventsKey: (keyof TState & string) | undefined,
        event: AgentLlmEvent,
    ): void {
        if (!eventsKey) return;
        const events = state[eventsKey];
        if (Array.isArray(events)) {
            events.push(event);
        }
    }
}
