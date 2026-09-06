/** Opt-in paired live check on fixed evidence; uses no workspace files or write tools. */
import { CodexSubscriptionProvider } from '../../providers/codex-subscription.js';
import { createHarnessExecution } from '../harness/execution.js';
import { budgetedContext } from '../harness/defaults.js';
import { retentionFixture } from './retention.js';
import type { IValidatedToolRuntime } from '../../contracts/tool-runtime.js';

const model = process.env.AGENTIC_EVAL_MODEL ?? 'gpt-5.6-terra';
const results = [];
for (const mode of ['full', 'recoverable', 'pressured'] as const) {
    const tokenBudget = mode === 'pressured' ? 2400 : 20000;
    const fixture = retentionFixture(), messages = structuredClone(fixture.messages);
    const trace: unknown[] = [];
    let answer = '', calls = 0, retrievals = 0, error: string | undefined;
    const start = Date.now(), usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    const execution = createHarnessExecution({ provider: new CodexSubscriptionProvider({ model, reasoningEffort: 'low' }),
        context: budgetedContext('Return only the exact archive code. Use read_saved when the source text has been replaced by a reference. Do not guess.', tokenBudget, {
            compressMessage: () => null,
            ...(mode === 'full' ? {} : { referenceToolResult: (_message, index) => `read_saved(${index})` }),
        }) });
    const tools: IValidatedToolRuntime = {
        tools: () => fixture.tools,
        validate(name, args) {
            const index = args.messageIndex;
            return name === 'read_saved' && Number.isSafeInteger(index) && typeof index === 'number' && index >= 0 && fixture.messages[index]?.role === 'tool_result'
                ? { ok: true, args: { messageIndex: index } }
                : { ok: false, result: { ok: false, content: 'Invalid saved source index', errorKind: 'validation' } };
        },
        async call(_name, args) { retrievals++; return { ok: true, content: fixture.messages[args.messageIndex as number].content }; },
    };
    const signal = AbortSignal.timeout(120000);
    try {
        while (calls < 4) {
            calls++;
            const response = await execution.model({ messages, tools: fixture.tools, maxTokens: 256 }, {
                signal, deadline: Date.now() + 45000, requireComplete: true,
                onIntent: intent => { trace.push({ type: 'intent', ...intent }); },
                onOutcome: receipt => { trace.push({ type: 'receipt', ...receipt }); },
            });
            usage.inputTokens += response.usage.inputTokens;
            usage.outputTokens += response.usage.outputTokens;
            usage.cacheReadTokens += response.usage.cacheReadTokens ?? 0;
            messages.push(response.message);
            if (!response.message.toolCalls?.length) { answer = response.message.content.trim(); break; }
            const batch = await execution.tools(response.message.toolCalls, { tools, signal, maxToolCallsPerTurn: 4 });
            for (const item of batch.executions) messages.push({ role: 'tool_result', toolCallId: item.callId,
                toolName: item.plan.name, content: item.result?.content ?? item.error ?? 'Tool failed', isError: !item.result?.ok });
        }
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    results.push({ mode, tokenBudget, passed: !error && answer === fixture.answer && (mode !== 'pressured' || retrievals > 0),
        answer, error, calls, retrievals, usage, durationMs: Date.now() - start, trace });
}
const passed = results.every(result => result.passed);
console.log(JSON.stringify({ version: 1, kind: 'paired-live-recovery', model, passed,
    limitation: 'Three fixed-evidence tasks in a fixed order; pressured mode has a smaller budget. Not a general agent benchmark or a statistically controlled latency comparison.', results }, null, 2));
process.exitCode = passed ? 0 : 1;
