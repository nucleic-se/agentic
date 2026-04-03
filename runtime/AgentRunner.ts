/**
 * AgentRunner — lightweight adapter that wraps any IGraphEngine as IAgent.
 *
 * This is a convenience adapter, not a full-fidelity IAgent implementation.
 * It bridges the graph execution model to the IAgent interface with the
 * following known limitations:
 *
 *   - executions[] is always empty — the graph's tool dispatch is internal.
 *   - tokenUsage is always zero — no per-turn token reporting hook exists at this layer.
 *   - outcome is always 'answered' — graph-level failures throw rather than setting TurnRecord.failure.
 *
 * These fields can only be populated accurately by an agent loop that owns the
 * tool dispatch cycle (a KernelAgent / AgentLoop design) — out of scope for Wave 1.
 *
 * What AgentRunner does provide correctly:
 *
 *   - Conversation history accumulated across turns (never trimmed).
 *   - Graph state preserved between turns (the engine retains its own accumulated state).
 *   - AssistantMessage preserved with toolCalls when the output key holds one.
 *   - Plan derived from assistantMsg.toolCalls (what the model requested).
 *   - clearSession() resets all buffers including the preserved graph state.
 */

import type { IAgent, AgentEventSink, TurnRecord, ToolPlan } from '../contracts/agent.js';
import type { Message, UserMessage, AssistantMessage } from '../contracts/llm.js';
import type { IGraphEngine, GraphState } from '../contracts/graph/index.js';

export interface AgentRunnerConfig<TState extends GraphState> {
    engine: IGraphEngine<TState>;
    /** Key in TState where the user input string is written before each run. */
    inputKey: keyof TState & string;
    /** Key in TState where the current message array is written before each run. */
    messagesKey: keyof TState & string;
    /**
     * Key in TState where the assistant output is read after each run.
     * May hold an AssistantMessage (from AgentLlmNode) or a plain string.
     */
    outputKey: keyof TState & string;
}

export class AgentRunner<TState extends GraphState> implements IAgent {
    readonly engine: IGraphEngine<TState>;

    #messages: Message[] = [];
    #history: TurnRecord[] = [];
    #lastState: TState | undefined;

    readonly #inputKey: keyof TState & string;
    readonly #messagesKey: keyof TState & string;
    readonly #outputKey: keyof TState & string;

    constructor(config: AgentRunnerConfig<TState>) {
        this.engine = config.engine;
        this.#inputKey = config.inputKey;
        this.#messagesKey = config.messagesKey;
        this.#outputKey = config.outputKey;
    }

    async prompt(input: string, sink?: AgentEventSink): Promise<TurnRecord[]> {
        const userMsg: UserMessage = { role: 'user', content: input };
        this.#messages.push(userMsg);
        return this.#run(input, sink);
    }

    async continue(sink?: AgentEventSink): Promise<TurnRecord[]> {
        return this.#run(null, sink);
    }

    getConversation(): readonly Message[] {
        return [...this.#messages];
    }

    getExecutionHistory(): readonly TurnRecord[] {
        return [...this.#history];
    }

    clearSession(): void {
        this.#messages = [];
        this.#history = [];
        this.#lastState = undefined;
    }

    async #run(userInput: string | null, _sink?: AgentEventSink): Promise<TurnRecord[]> {
        const startMs = Date.now();

        // Merge state update into last known graph state so the engine retains
        // any internal state it accumulated in previous turns.
        const stateUpdate: Record<string, unknown> = {
            [this.#inputKey]:    userInput ?? '',
            [this.#messagesKey]: [...this.#messages],
        };
        const initialState = { ...(this.#lastState ?? {}), ...stateUpdate } as TState;

        const result = await this.engine.run(initialState);

        // Preserve engine state for next turn
        this.#lastState = result.state;

        // Extract assistant output — AgentLlmNode writes AssistantMessage; simple nodes write strings.
        const rawOutput = result.state[this.#outputKey];
        const assistantMsg: AssistantMessage =
            rawOutput != null &&
            typeof rawOutput === 'object' &&
            (rawOutput as Record<string, unknown>)['role'] === 'assistant'
                ? (rawOutput as unknown as AssistantMessage)
                : { role: 'assistant', content: String(rawOutput ?? '') };

        this.#messages.push(assistantMsg);

        // Build plan from tool calls the model requested (best-effort; no execution hooks here)
        const plan: ToolPlan[] = (assistantMsg.toolCalls ?? []).map(tc => ({
            callId:    tc.id,
            name:      tc.name,
            input:     tc.args,
        }));

        const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const record: TurnRecord = {
            turnId,
            userInput,
            modelRequest: {
                messages: this.#messages.slice(0, -1),
            },
            modelResponse: assistantMsg,
            plan,
            executions: [],
            outcome:    'answered',
            durationMs: Date.now() - startMs,
            tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };

        this.#history.push(record);
        return [record];
    }
}
