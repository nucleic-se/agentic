/** Explicit opt-in subscription evaluation; never invoked by the ordinary test suite. */
import { CodexSubscriptionProvider } from '../../providers/codex-subscription.js';
import { executeModelTurn } from '../ModelExecutor.js';
import { composeAgentContext } from '../ContextPipeline.js';
import { contextEvaluationCases } from './context.js';

const model = process.env.AGENTIC_EVAL_MODEL ?? 'gpt-6-astra';
const provider = new CodexSubscriptionProvider({ model, reasoningEffort: 'low' });
const results: unknown[] = [];
let passed = true;
for (const test of contextEvaluationCases().filter(test => test.id.startsWith('priority-over-recency-'))) {
    const fixture = test.create();
    fixture.input.system += '\nReturn only the current route and access code in ROUTE:CODE format, without commentary.';
    const start = Date.now();
    try {
        const prepared = await composeAgentContext(fixture.input, fixture.options);
        const response = await executeModelTurn(provider, { system: prepared.system, messages: prepared.messages,
            tools: [], maxTokens: fixture.input.reservedOutputTokens ?? 128 }, {
            deadline: Date.now() + 45000, allowToolCalls: false, requireComplete: true,
        });
        const success = response.message.content.trim() === test.oracle!.expected;
        passed &&= success;
        results.push({ id: test.id, passed: success, answer: response.message.content.trim(),
            usage: response.usage, preparedEstimatedTokens: prepared.usage.totalTokens, durationMs: Date.now() - start });
    } catch (error) {
        passed = false;
        results.push({ id: test.id, passed: false, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - start });
    }
}
process.stdout.write(JSON.stringify({ version: 1, kind: 'live-model-context-task', model, passed,
    limitation: 'Two constrained fact-extraction tasks; this is not a general coding-agent capability benchmark.', results }, null, 2) + '\n');
process.exitCode = passed ? 0 : 1;
