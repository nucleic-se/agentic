/**
 * @nucleic/agentic library tests.
 *
 * Standalone tests for the generic primitives extracted from Aquarium.
 * These tests don't depend on Aquarium, Container, or any domain code.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
    PromptEngine,
    PromptContributorRegistry,
    TickPipeline,
    InMemoryTracer,
    InMemorySpanTracer,
    PackRegistry,
    PackMigrationRunner,
    InMemoryMigrationState,
    AIPromptService,
    AIPipeline,
    ToolRegistry,
    InMemoryStore,
    ToolPromptRenderer,
    ContextAssembler,
    AgentContextAssembler,
    AgentRunner,
    ToolRuntimeAdapter,
    CompositeToolRuntime,
    PlanningCapability,
    BudgetHintCapability,
    EmptyResponseCapability,
    estimateTokens,
} from './index.js';

import type {
    PromptSection,
    ITickStep,
    IPackManifest,
    ILLMProvider,
    StructuredRequest,
    TurnRequest,
    ITool,
    ToolResult,
    IGraphEngine,
    GraphState,
    GraphRunResult,
    IToolPolicy,
    PolicyContext,
    PolicyDecision,
    TurnRecord,
    JsonSchema,
} from './index.js';

// ── Helpers ────────────────────────────────────────────────────

function section(id: string, priority: number, weight: number, tokens: number, opts?: Partial<PromptSection>): PromptSection {
    return {
        id,
        priority,
        weight,
        estimatedTokens: tokens,
        text: () => `[${id}]`,
        tags: [],
        ...opts,
    };
}

function manifest(id: string, provides: string[] = [], requires: string[] = []): IPackManifest {
    return { id, version: '1.0.0', provides, requires, migrations: [] };
}

const fakeLLM: ILLMProvider = {
    async structured(req: StructuredRequest) {
        const text = req.messages.map(m => typeof m.content === 'string' ? m.content : '').join('');
        return { value: `echo: ${text}`, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async turn(req: TurnRequest) {
        const text = req.messages.map(m => typeof m.content === 'string' ? m.content : '').join('');
        return {
            message:    { role: 'assistant' as const, content: `echo: ${text}`, toolCalls: [] },
            stopReason: 'end_turn' as const,
            usage:      { inputTokens: 0, outputTokens: 0 },
        };
    },
    async embed(_texts: string[]): Promise<number[][]> {
        return [[0.1, 0.2, 0.3]];
    },
};

// ── PromptEngine ───────────────────────────────────────────────

describe('PromptEngine', () => {
    const engine = new PromptEngine();

    it('returns empty result for no sections', () => {
        const r = engine.compose([], 1000);
        expect(r.text).toBe('');
        expect(r.included).toHaveLength(0);
        expect(r.totalTokens).toBe(0);
    });

    it('includes all sections within budget', () => {
        const sections = [section('a', 1, 1, 10), section('b', 2, 1, 10)];
        const r = engine.compose(sections, 100);
        expect(r.included).toHaveLength(2);
        expect(r.excluded).toHaveLength(0);
    });

    it('trims lowest-score sections when over budget', () => {
        const sections = [section('low', 1, 1, 50), section('high', 10, 1, 50)];
        const r = engine.compose(sections, 60);
        expect(r.included).toHaveLength(1);
        expect(r.included[0].id).toBe('high');
        expect(r.excluded[0].id).toBe('low');
    });

    it('sticky sections are always included', () => {
        const sections = [
            section('sticky', 1, 1, 50, { sticky: true }),
            section('normal', 100, 1, 50),
        ];
        const r = engine.compose(sections, 60);
        expect(r.included.map((s: PromptSection) => s.id)).toContain('sticky');
    });

    it('uses contextMultiplier in scoring', () => {
        const sections = [
            section('boosted', 1, 1, 10, { contextMultiplier: 100 }),
            section('base', 10, 1, 10),
        ];
        const r = engine.compose(sections, 15);
        expect(r.included[0].id).toBe('boosted');
    });

    it('breaks ties deterministically by id', () => {
        const sections = [section('b', 5, 1, 10), section('a', 5, 1, 10)];
        const r = engine.compose(sections, 100);
        // Both included, but 'a' (lower alpha) should come after sticky (none) in score order
        expect(r.included[0].id).toBe('a');
        expect(r.included[1].id).toBe('b');
    });
});

// ── PromptContributorRegistry ──────────────────────────────────

describe('PromptContributorRegistry', () => {
    it('register, list, resolve', () => {
        const reg = new PromptContributorRegistry();
        const c = { id: 'test', contribute: () => [] };
        reg.register(c);
        expect(reg.list()).toHaveLength(1);
        expect(reg.resolve('test')).toBe(c);
        expect(reg.resolve('missing')).toBeNull();
    });
});

// ── TickPipeline ───────────────────────────────────────────────

describe('TickPipeline', () => {
    it('runs steps in order', async () => {
        const pipeline = new TickPipeline();
        const log: string[] = [];

        const stepA: ITickStep = { id: 'a', after: ['b'], execute: async () => { log.push('a'); } };
        const stepB: ITickStep = { id: 'b', execute: async () => { log.push('b'); } };

        pipeline.registerStep(stepA);
        pipeline.registerStep(stepB);

        await pipeline.run('sim1', { correlationId: 'sim1', tick: 1, stepState: {} });
        expect(log).toEqual(['b', 'a']); // b has no deps, a requires b
    });

    it('throws on empty pipeline', async () => {
        const pipeline = new TickPipeline();
        await expect(
            pipeline.run('sim1', { correlationId: 'sim1', tick: 1, stepState: {} })
        ).rejects.toThrow('No tick steps registered');
    });

    it('replaces step with same id', () => {
        const pipeline = new TickPipeline();
        const execute1 = async () => {};
        const execute2 = async () => {};
        pipeline.registerStep({ id: 'x', execute: execute1 });
        pipeline.registerStep({ id: 'x', execute: execute2 });
        expect(pipeline.listSteps()).toHaveLength(1);
        expect(pipeline.listSteps()[0].execute).toBe(execute2);
    });

    it('resolveStep returns step by id, null for unknown', () => {
        const pipeline = new TickPipeline();
        const step: ITickStep = { id: 'alpha', execute: async () => {} };
        pipeline.registerStep(step);
        expect(pipeline.resolveStep('alpha')).toBe(step);
        expect(pipeline.resolveStep('missing')).toBeNull();
    });
});

// ── InMemoryTracer ─────────────────────────────────────────────

describe('InMemoryTracer', () => {
    it('traces and queries recent events', () => {
        const tracer = new InMemoryTracer(100);
        tracer.trace({ correlationId: 's1', type: 'test', timestamp: 1, data: { a: 1 } });
        tracer.trace({ correlationId: 's1', type: 'test', timestamp: 2, data: { a: 2 } });
        tracer.trace({ correlationId: 's2', type: 'test', timestamp: 3, data: {} });

        const recent = tracer.recent('s1', 10);
        expect(recent).toHaveLength(2);
        expect(recent[0].timestamp).toBe(2); // most recent first
    });

    it('ring buffer drops oldest', () => {
        const tracer = new InMemoryTracer(2);
        tracer.trace({ correlationId: 's1', type: 'a', timestamp: 1, data: {} });
        tracer.trace({ correlationId: 's1', type: 'b', timestamp: 2, data: {} });
        tracer.trace({ correlationId: 's1', type: 'c', timestamp: 3, data: {} });

        const recent = tracer.recent('s1', 10);
        expect(recent).toHaveLength(2);
        expect(recent.map((e: { type: string }) => e.type)).toEqual(['c', 'b']);
    });
});

// ── PackRegistry ───────────────────────────────────────────────

describe('PackRegistry', () => {
    it('registers and lists manifests', () => {
        const reg = new PackRegistry();
        reg.registerManifest(manifest('a'));
        reg.registerManifest(manifest('b'));
        expect(reg.listManifests()).toHaveLength(2);
        expect(reg.getManifest('a')?.id).toBe('a');
        expect(reg.getManifest('z')).toBeNull();
    });

    it('validates missing dependencies', () => {
        const reg = new PackRegistry();
        reg.registerManifest(manifest('a', ['svc-a'], []));
        reg.registerManifest(manifest('b', [], ['svc-x'])); // requires missing svc-x

        const errors = reg.validateDependencies(['a', 'b']);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].message).toContain('svc-x');
    });

    it('resolves boot order respecting dependencies', () => {
        const reg = new PackRegistry();
        reg.registerManifest(manifest('db', ['database'], []));
        reg.registerManifest(manifest('app', [], ['database']));

        const order = reg.resolveBootOrder(['db', 'app']);
        expect(order.map((m: IPackManifest) => m.id)).toEqual(['db', 'app']);
    });

    it('detects circular dependencies', () => {
        const reg = new PackRegistry();
        reg.registerManifest(manifest('a', ['svc-a'], ['svc-b']));
        reg.registerManifest(manifest('b', ['svc-b'], ['svc-a']));

        expect(() => reg.resolveBootOrder(['a', 'b'])).toThrow('Circular dependency');
    });

    it('validateDependencies returns error for unregistered pack', () => {
        const reg = new PackRegistry();
        // 'ghost' is not registered but is listed as enabled
        const errors = reg.validateDependencies(['ghost']);
        expect(errors).toHaveLength(1);
        expect(errors[0].packId).toBe('ghost');
        expect(errors[0].message).toContain('not registered');
    });

    it('validateDependencies returns error for duplicate token providers', () => {
        const reg = new PackRegistry();
        reg.registerManifest(manifest('a', ['storage'], []));
        reg.registerManifest(manifest('b', ['storage'], [])); // duplicate provider for 'storage'

        const errors = reg.validateDependencies(['a', 'b']);
        expect(errors.some(e => e.message.includes('Duplicate'))).toBe(true);
    });
});

// ── PackMigrationRunner ──────────────────────────────────────

describe('PackMigrationRunner', () => {
    it('runs unapplied migrations and skips applied ones', async () => {
        const state = new InMemoryMigrationState();
        const log: string[] = [];
        const orch = new PackMigrationRunner(state, null);

        const m: IPackManifest = {
            ...manifest('pack1'),
            migrations: [
                { id: 'm1', up: async () => { log.push('m1'); } },
                { id: 'm2', up: async () => { log.push('m2'); } },
            ],
        };

        const applied1 = await orch.migrate([m]);
        expect(applied1).toEqual(['pack1::m1', 'pack1::m2']);
        expect(log).toEqual(['m1', 'm2']);

        // Running again skips already-applied
        const applied2 = await orch.migrate([m]);
        expect(applied2).toEqual([]);
    });
});

// ── estimateTokens ─────────────────────────────────────────────

describe('estimateTokens', () => {
    it('estimates ~4 chars per token', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('abcd')).toBe(1);
        expect(estimateTokens('abcde')).toBe(2);
        expect(estimateTokens('a'.repeat(100))).toBe(25);
    });
});

// ── AIPromptService (with fake LLM) ───────────────────────────

describe('AIPromptService', () => {
    it('builds and runs a prompt', async () => {
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.use().user('hello').run();
        expect(result).toBe('echo: hello');
    });

    it('stacks system and user messages', async () => {
        const calls: TurnRequest[] = [];
        const spyLLM: ILLMProvider = {
            async structured(req: StructuredRequest) {
                return { value: 'ok', usage: { inputTokens: 0, outputTokens: 0 } };
            },
            async turn(req: TurnRequest) {
                calls.push(req);
                return {
                    message:    { role: 'assistant' as const, content: 'ok', toolCalls: [] },
                    stopReason: 'end_turn' as const,
                    usage:      { inputTokens: 0, outputTokens: 0 },
                };
            },
            async embed() { return []; },
        };

        const svc = new AIPromptService(spyLLM);
        await svc.use().system('sys1').system('sys2').user('u1').user('u2').run();

        expect(calls[0].system).toBe('sys1\n\nsys2');
        expect(calls[0].messages[0]).toMatchObject({ role: 'user', content: 'u1\n\nu2' });
    });
});

// ── AIPipeline ─────────────────────────────────────────────────

describe('AIPipeline', () => {
    it('chains pipe steps', async () => {
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.pipeline(1)
            .pipe(async (n: number) => n + 1)
            .pipe(async (n: number) => n * 10)
            .run();
        expect(result).toBe(20);
    });

    it('catch handler intercepts errors', async () => {
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.pipeline('start')
            .pipe((_s: string): string => { throw new Error('boom'); })
            .catch(() => 'recovered')
            .run();
        expect(result).toBe('recovered');
    });

    it('retry retries on failure', async () => {
        let attempts = 0;
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.pipeline('x')
            .pipe(() => {
                attempts++;
                if (attempts < 3) throw new Error('fail');
                return 'done';
            })
            .retry(5)
            .run();
        expect(result).toBe('done');
        expect(attempts).toBe(3);
    });

    it('uses startValue from constructor when run() is called without argument', async () => {
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.pipeline(5)
            .pipe((n: number) => n * 3)
            .run(); // no argument — uses startValue: 5
        expect(result).toBe(15);
    });

    it('transform() chains a transformation onto last step output', async () => {
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.pipeline(4)
            .pipe((n: number) => n * 2)   // step[0] → 8
            .transform((n: number) => n + 1) // wraps step[0] → (4*2)+1 = 9
            .run();
        expect(result).toBe(9);
    });

    it('validate() passes through value when schema is satisfied', async () => {
        const svc = new AIPromptService(fakeLLM);
        const result = await svc.pipeline('hello')
            .pipe((s: string) => s.toUpperCase())
            .validate(z.string().min(1))
            .run();
        expect(result).toBe('HELLO');
    });

    it('validate() throws Validation Error when schema fails', async () => {
        const svc = new AIPromptService(fakeLLM);
        await expect(
            svc.pipeline(42)
                .pipe((n: number) => n)
                .validate(z.string()) // number does not satisfy z.string()
                .run(),
        ).rejects.toThrow('Validation Error');
    });
});
// ── PromptEngine — Phase Ordering ──────────────────────────────────

describe('PromptEngine — phase ordering', () => {
    const engine = new PromptEngine();

    it('orders sections by phase before score', () => {
        const sections: PromptSection[] = [
            section('user-msg', 100, 1, 10, { phase: 'user' }),
            section('task-def', 50, 1, 10, { phase: 'task' }),
            section('constraint', 1, 1, 10, { phase: 'constraint' }),
            section('memory-item', 30, 1, 10, { phase: 'memory' }),
        ];
        const result = engine.compose(sections, 1000);
        const ids = result.included.map((s: PromptSection) => s.id);
        expect(ids.indexOf('constraint')).toBeLessThan(ids.indexOf('task-def'));
        expect(ids.indexOf('task-def')).toBeLessThan(ids.indexOf('memory-item'));
        expect(ids.indexOf('memory-item')).toBeLessThan(ids.indexOf('user-msg'));
    });

    it('ranks by score within the same phase', () => {
        const sections: PromptSection[] = [
            section('mem-low', 1, 1, 10, { phase: 'memory' }),
            section('mem-high', 100, 1, 10, { phase: 'memory' }),
        ];
        const result = engine.compose(sections, 1000);
        const ids = result.included.map((s: PromptSection) => s.id);
        expect(ids.indexOf('mem-high')).toBeLessThan(ids.indexOf('mem-low'));
    });

    it('sticky sections appear before non-sticky regardless of phase', () => {
        const sections: PromptSection[] = [
            section('late-sticky', 1, 1, 10, { phase: 'user', sticky: true }),
            section('early-task', 100, 1, 10, { phase: 'constraint' }),
        ];
        const result = engine.compose(sections, 1000);
        const ids = result.included.map((s: PromptSection) => s.id);
        expect(ids.indexOf('late-sticky')).toBeLessThan(ids.indexOf('early-task'));
    });

    it('unknown phase falls back to task', () => {
        const sections: PromptSection[] = [
            section('unknown', 50, 1, 10, { phase: 'bogus' as any }),
            section('constraint', 1, 1, 10, { phase: 'constraint' }),
        ];
        const result = engine.compose(sections, 1000);
        const ids = result.included.map((s: PromptSection) => s.id);
        // constraint phase comes before task (fallback for unknown)
        expect(ids.indexOf('constraint')).toBeLessThan(ids.indexOf('unknown'));
    });

    it('defaults to task phase when phase is omitted', () => {
        const sections: PromptSection[] = [
            section('no-phase', 50, 1, 10),     // no phase → defaults to 'task'
            section('memory', 1, 1, 10, { phase: 'memory' }),
        ];
        const result = engine.compose(sections, 1000);
        const ids = result.included.map((s: PromptSection) => s.id);
        // task comes before memory in phase order
        expect(ids.indexOf('no-phase')).toBeLessThan(ids.indexOf('memory'));
    });
});

// ── ToolRegistry ──────────────────────────────────────────────────

describe('ToolRegistry', () => {
    function makeTool(name: string, tier: ITool['trustTier'] = 'standard'): ITool {
        return {
            name,
            description: `tool ${name}`,
            inputSchema: { type: 'object' },
            trustTier: tier,
            execute: async (input: unknown) => input,
        };
    }

    it('registers and resolves a tool', () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('clock'));
        const resolved = reg.resolve('clock');
        expect(resolved).toBeDefined();
        expect(resolved!.name).toBe('clock');
    });

    it('returns undefined for unknown tool', () => {
        const reg = new ToolRegistry();
        expect(reg.resolve('missing')).toBeUndefined();
    });

    it('lists all registered tools', () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('a'));
        reg.register(makeTool('b'));
        expect(reg.list()).toHaveLength(2);
        expect(reg.list().map(t => t.name)).toEqual(['a', 'b']);
    });

    it('throws on duplicate tool name', () => {
        const reg = new ToolRegistry();
        reg.register(makeTool('dup'));
        expect(() => reg.register(makeTool('dup'))).toThrow("'dup' is already registered");
    });

    it('throws on empty tool name', () => {
        const reg = new ToolRegistry();
        expect(() => reg.register(makeTool(''))).toThrow('non-empty string');
    });

    it('throws on blank tool name', () => {
        const reg = new ToolRegistry();
        expect(() => reg.register(makeTool('   '))).toThrow('non-empty string');
    });

    it('executes a registered tool', async () => {
        const reg = new ToolRegistry();
        const tool: ITool<{ x: number }, number> = {
            name: 'double',
            description: 'doubles input',
            inputSchema: { type: 'object' },
            trustTier: 'trusted',
            execute: async ({ x }) => x * 2,
        };
        reg.register(tool as ITool);
        const result = await reg.resolve('double')!.execute({ x: 5 });
        expect(result).toBe(10);
    });
});

// ── InMemoryStore ───────────────────────────────────────────────

describe('InMemoryStore', () => {
    function baseItem() {
        return {
            type: 'semantic' as const,
            key: 'test-key',
            value: 'hello',
            confidence: 0.8,
            source: 'test',
            tags: ['a', 'b'],
        };
    }

    it('writes and retrieves an item by id', async () => {
        const store = new InMemoryStore();
        const written = await store.write(baseItem());
        expect(written.id).toBeTruthy();
        expect(written.version).toBe(1);
        expect(written.createdAt).toBeGreaterThan(0);

        const fetched = await store.get(written.id);
        expect(fetched).toEqual(written);
    });

    it('returns undefined for missing id', async () => {
        const store = new InMemoryStore();
        expect(await store.get('no-such-id')).toBeUndefined();
    });

    it('updates an item and bumps version', async () => {
        const store = new InMemoryStore();
        const item = await store.write(baseItem());
        const updated = await store.update(item.id, { value: 'updated', confidence: 0.99 });
        expect(updated.value).toBe('updated');
        expect(updated.confidence).toBe(0.99);
        expect(updated.version).toBe(2);
    });

    it('throws when updating non-existent id', async () => {
        const store = new InMemoryStore();
        await expect(store.update('ghost', { value: 'x' })).rejects.toThrow("'ghost' not found");
    });

    it('deletes an item', async () => {
        const store = new InMemoryStore();
        const item = await store.write(baseItem());
        await store.delete(item.id);
        expect(await store.get(item.id)).toBeUndefined();
    });

    it('queries by type', async () => {
        const store = new InMemoryStore();
        await store.write({ ...baseItem(), type: 'semantic' });
        await store.write({ ...baseItem(), type: 'episodic' });
        const results = await store.query({ types: ['semantic'], limit: 10 });
        expect(results).toHaveLength(1);
        expect(results[0].type).toBe('semantic');
    });

    it('queries by tags (any match)', async () => {
        const store = new InMemoryStore();
        await store.write({ ...baseItem(), tags: ['x', 'y'] });
        await store.write({ ...baseItem(), tags: ['z'] });
        const results = await store.query({ tags: ['x'], limit: 10 });
        expect(results).toHaveLength(1);
    });

    it('respects limit', async () => {
        const store = new InMemoryStore();
        for (let i = 0; i < 5; i++) await store.write({ ...baseItem(), key: `k${i}` });
        const results = await store.query({ limit: 3 });
        expect(results).toHaveLength(3);
    });

    it('sorts by confidence desc, then recency desc', async () => {
        const store = new InMemoryStore();
        const low = await store.write({ ...baseItem(), confidence: 0.1, key: 'low' });
        const high = await store.write({ ...baseItem(), confidence: 0.9, key: 'high' });
        const results = await store.query({ limit: 10 });
        expect(results[0].id).toBe(high.id);
        expect(results[1].id).toBe(low.id);
    });

    it('evicts expired items on evictExpired()', async () => {
        const store = new InMemoryStore();
        // Write with -1 day TTL (already expired)
        const expired = await store.write({ ...baseItem(), ttlDays: -1 });
        // Call evictExpired() directly without triggering lazy eviction first
        const count = await store.evictExpired();
        expect(count).toBe(1);
        expect(await store.get(expired.id)).toBeUndefined();
    });

    it('write() lazily evicts expired items', async () => {
        const store = new InMemoryStore();
        const expired = await store.write({ ...baseItem(), ttlDays: -1 });
        // Writing a new item should trigger lazy eviction
        await store.write(baseItem());
        expect(await store.get(expired.id)).toBeUndefined();
    });

    it('query() excludes expired items', async () => {
        const store = new InMemoryStore();
        await store.write({ ...baseItem(), ttlDays: -1, key: 'expired' });
        await store.write({ ...baseItem(), key: 'live' });
        const results = await store.query({ limit: 10 });
        expect(results).toHaveLength(1);
        expect(results[0].key).toBe('live');
    });

    it('get() does not return expired items', async () => {
        const store = new InMemoryStore();
        const expired = await store.write({ ...baseItem(), ttlDays: -1, key: 'expired' });
        expect(await store.get(expired.id)).toBeUndefined();
    });

    it('tokenBudget limits total tokens in query', async () => {
        const store = new InMemoryStore();
        // Each item value is a long string
        for (let i = 0; i < 5; i++) {
            await store.write({ ...baseItem(), value: 'a'.repeat(100), key: `k${i}` });
        }
        const results = await store.query({ limit: 10, tokenBudget: 10 });
        // Should return fewer items than limit due to token budget
        expect(results.length).toBeLessThan(5);
    });
});

// ── InMemorySpanTracer ──────────────────────────────────────────

describe('InMemorySpanTracer', () => {
    it('opens and closes a root span', () => {
        const tracer = new InMemorySpanTracer();
        const spanId = tracer.startSpan({
            correlationId: 'run-1',
            type: 'graph-run',
            startTime: Date.now(),
            metadata: {},
        });
        expect(spanId).toBeTruthy();

        tracer.endSpan(spanId, 'ok');
        const spans = tracer.spans('run-1');
        expect(spans).toHaveLength(1);
        expect(spans[0].status).toBe('ok');
        expect(spans[0].endTime).toBeGreaterThan(0);
    });

    it('supports parent-child span relationships', () => {
        const tracer = new InMemorySpanTracer();
        const rootId = tracer.startSpan({ correlationId: 'r', type: 'root', startTime: 1, metadata: {} });
        const childId = tracer.startSpan({ correlationId: 'r', parentSpanId: rootId, type: 'child', startTime: 2, metadata: {} });
        tracer.endSpan(childId, 'ok');
        tracer.endSpan(rootId, 'ok');

        const spans = tracer.spans('r');
        expect(spans).toHaveLength(2);
        const child = spans.find(s => s.type === 'child')!;
        expect(child.parentSpanId).toBe(rootId);
    });

    it('spans() filters by correlationId', () => {
        const tracer = new InMemorySpanTracer();
        const s1 = tracer.startSpan({ correlationId: 'a', type: 'x', startTime: 1, metadata: {} });
        const s2 = tracer.startSpan({ correlationId: 'b', type: 'y', startTime: 1, metadata: {} });
        tracer.endSpan(s1, 'ok');
        tracer.endSpan(s2, 'ok');
        expect(tracer.spans('a')).toHaveLength(1);
        expect(tracer.spans('b')).toHaveLength(1);
    });

    it('endSpan records error message', () => {
        const tracer = new InMemorySpanTracer();
        const id = tracer.startSpan({ correlationId: 'r', type: 't', startTime: 1, metadata: {} });
        tracer.endSpan(id, 'error', 'something went wrong');
        const span = tracer.spans('r')[0];
        expect(span.status).toBe('error');
        expect(span.error).toBe('something went wrong');
    });

    it('export() returns all finalized spans', () => {
        const tracer = new InMemorySpanTracer();
        const a = tracer.startSpan({ correlationId: 'c1', type: 'a', startTime: 1, metadata: {} });
        const b = tracer.startSpan({ correlationId: 'c2', type: 'b', startTime: 1, metadata: {} });
        tracer.endSpan(a, 'ok');
        tracer.endSpan(b, 'cancelled');
        expect(tracer.export()).toHaveLength(2);
    });

    it('endSpan is a no-op for unknown spanId', () => {
        const tracer = new InMemorySpanTracer();
        expect(() => tracer.endSpan('does-not-exist', 'ok')).not.toThrow();
    });

    it('also implements ITracer (trace/recent)', () => {
        const tracer = new InMemorySpanTracer();
        tracer.trace({ correlationId: 'x', type: 'evt', timestamp: 1, data: {} });
        const recent = tracer.recent('x', 10);
        expect(recent).toHaveLength(1);
        expect(recent[0].type).toBe('evt');
    });

    it('inherits ring-buffer behaviour from InMemoryTracer', () => {
        // maxEvents = 2 via constructor — third event should evict the first.
        const tracer = new InMemorySpanTracer(2);
        tracer.trace({ correlationId: 'r', type: 'a', timestamp: 1, data: {} });
        tracer.trace({ correlationId: 'r', type: 'b', timestamp: 2, data: {} });
        tracer.trace({ correlationId: 'r', type: 'c', timestamp: 3, data: {} });
        const recent = tracer.recent('r', 10);
        expect(recent).toHaveLength(2);
        expect(recent.map(e => e.type)).toEqual(['c', 'b']);
    });

    it('emits a flat trace event on endSpan for backward compat', () => {
        const tracer = new InMemorySpanTracer();
        const id = tracer.startSpan({ correlationId: 'z', type: 'work', startTime: 1, metadata: { extra: true } });
        tracer.endSpan(id, 'ok');
        const events = tracer.recent('z', 10);
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].type).toBe('span.work');
    });
});

// ── ToolPromptRenderer ──────────────────────────────────────────

describe('ToolPromptRenderer', () => {
    function makeResult(name: string, tier: ToolResult['trustTier'], data: unknown = 'ok-data'): ToolResult {
        return {
            toolName: name,
            requestId: `req-${name}`,
            timestamp: Date.now(),
            latencyMs: 10,
            trustTier: tier,
            status: 'ok',
            data,
        };
    }

    it('renders a single trusted result with VERIFIED label', () => {
        const renderer = new ToolPromptRenderer();
        const sections = renderer.render([makeResult('clock', 'trusted')]);
        expect(sections).toHaveLength(1);
        expect(sections[0].text()).toContain('[TOOL RESULTS — VERIFIED]');
        // Trusted sections have the highest priority but are NOT sticky — the
        // engine can drop them under genuine budget pressure.
        expect(sections[0].sticky).toBe(false);
        expect(sections[0].phase).toBe('tools');
    });

    it('renders untrusted result with explicit warning label', () => {
        const renderer = new ToolPromptRenderer();
        const sections = renderer.render([makeResult('search', 'untrusted')]);
        expect(sections[0].text()).toContain('UNTRUSTED EXTERNAL DATA');
        expect(sections[0].sticky).toBe(false);
    });

    it('groups results by tier into separate sections', () => {
        const renderer = new ToolPromptRenderer();
        const sections = renderer.render([
            makeResult('t', 'trusted'),
            makeResult('s', 'standard'),
            makeResult('u', 'untrusted'),
        ]);
        expect(sections).toHaveLength(3);
    });

    it('renders in canonical tier order regardless of input order', () => {
        const renderer = new ToolPromptRenderer();
        // Supply results in reverse canonical order
        const sections = renderer.render([
            makeResult('u', 'untrusted'),
            makeResult('s', 'standard'),
            makeResult('t', 'trusted'),
        ]);
        expect(sections[0].id).toBe('tool-results-trusted');
        expect(sections[1].id).toBe('tool-results-standard');
        expect(sections[2].id).toBe('tool-results-untrusted');
    });

    it('trusted section has higher priority than untrusted', () => {
        const renderer = new ToolPromptRenderer();
        const sections = renderer.render([
            makeResult('t', 'trusted'),
            makeResult('u', 'untrusted'),
        ]);
        const trusted = sections.find(s => s.id === 'tool-results-trusted')!;
        const untrusted = sections.find(s => s.id === 'tool-results-untrusted')!;
        expect(trusted.priority).toBeGreaterThan(untrusted.priority);
    });

    it('returns empty array for empty input', () => {
        const renderer = new ToolPromptRenderer();
        expect(renderer.render([])).toHaveLength(0);
    });

    it('renders error result with error field', () => {
        const renderer = new ToolPromptRenderer();
        const errResult: ToolResult = {
            toolName: 'fail',
            requestId: 'r1',
            timestamp: Date.now(),
            latencyMs: 5,
            trustTier: 'standard',
            status: 'error',
            data: null,
            error: 'network timeout',
        };
        const sections = renderer.render([errResult]);
        expect(sections[0].text()).toContain('Error: network timeout');
    });
});

// ── ContextAssembler ─────────────────────────────────────────────

describe('ContextAssembler', () => {
    function makeAssembler() {
        return new ContextAssembler(new PromptEngine(), new ToolPromptRenderer());
    }

    it('assembles contributor sections without tool results', () => {
        const assembler = makeAssembler();
        const result = assembler.assemble({
            contributorSections: [section('s1', 10, 1, 50), section('s2', 5, 1, 50)],
            tokenBudget: 200,
        });
        expect(result.included).toHaveLength(2);
        expect(result.excluded).toHaveLength(0);
    });

    it('renders tool results and merges them with contributor sections', () => {
        const assembler = makeAssembler();
        const toolResult: ToolResult = {
            toolName: 'clock',
            requestId: 'r1',
            timestamp: Date.now(),
            latencyMs: 1,
            trustTier: 'trusted',
            status: 'ok',
            data: 1234567890,
        };
        const result = assembler.assemble({
            contributorSections: [section('task', 10, 1, 50)],
            toolResults: [toolResult],
            tokenBudget: 2000,
        });
        // Should include both the task section and the rendered tool section
        expect(result.included.some(s => s.id === 'task')).toBe(true);
        expect(result.included.some(s => s.id === 'tool-results-trusted')).toBe(true);
        expect(result.text).toContain('[TOOL RESULTS — VERIFIED]');
    });

    it('trims sections over budget', () => {
        const assembler = makeAssembler();
        const result = assembler.assemble({
            contributorSections: [
                section('big', 1, 1, 900),
                section('small', 100, 1, 10),
            ],
            tokenBudget: 50,
        });
        expect(result.included.some(s => s.id === 'small')).toBe(true);
        expect(result.excluded.some(s => s.id === 'big')).toBe(true);
    });

    it('handles empty tool results gracefully', () => {
        const assembler = makeAssembler();
        const result = assembler.assemble({
            contributorSections: [section('s', 10, 1, 10)],
            toolResults: [],
            tokenBudget: 100,
        });
        expect(result.included).toHaveLength(1);
    });
});

// ── ToolRuntimeAdapter ─────────────────────────────────────────

describe('ToolRuntimeAdapter', () => {
    function makeTool(name: string, value: unknown, tier: ITool['trustTier'] = 'standard'): ITool {
        return {
            name,
            description: `tool ${name}`,
            trustTier: tier,
            inputSchema: { type: 'object', properties: {} },
            execute: async (_args: Record<string, unknown>) => value,
        };
    }

    it('returns string content for string tool output', async () => {
        const adapter = new ToolRuntimeAdapter([makeTool('echo', 'hello')]);
        const result = await adapter.call('echo', {});
        expect(result.ok).toBe(true);
        expect(result.content).toBe('hello');
        expect(result.data).toBeUndefined();
    });

    it('serializes object output to JSON content and preserves data', async () => {
        const value = { count: 3, items: ['a', 'b', 'c'] };
        const adapter = new ToolRuntimeAdapter([makeTool('list', value)]);
        const result = await adapter.call('list', {});
        expect(result.ok).toBe(true);
        expect(result.content).toBe(JSON.stringify(value));
        expect(result.data).toEqual(value);
    });

    it('returns ok:false for unknown tool', async () => {
        const adapter = new ToolRuntimeAdapter([]);
        const result = await adapter.call('nope', {});
        expect(result.ok).toBe(false);
        expect(result.content).toContain('nope');
    });

    it('reports trust tier via trustTierFor', () => {
        const adapter = new ToolRuntimeAdapter([
            makeTool('a', '', 'trusted'),
            makeTool('b', '', 'untrusted'),
        ]);
        expect(adapter.trustTierFor('a')).toBe('trusted');
        expect(adapter.trustTierFor('b')).toBe('untrusted');
        expect(adapter.trustTierFor('missing')).toBeUndefined();
    });

    it('applies policy deny before executing', async () => {
        const policy: IToolPolicy = {
            evaluate: async (_ctx: PolicyContext): Promise<PolicyDecision> => ({ kind: 'deny', reason: 'blocked' }),
        };
        const executed = vi.fn();
        const tool = makeTool('t', 'ok');
        tool.execute = executed;
        const adapter = new ToolRuntimeAdapter([tool], policy);
        const result = await adapter.call('t', {});
        expect(result.ok).toBe(false);
        expect(result.content).toBe('blocked');
        expect(executed).not.toHaveBeenCalled();
    });
});

// ── CompositeToolRuntime ────────────────────────────────────────

describe('CompositeToolRuntime', () => {
    function makeRuntime(toolName: string, tier: 'trusted' | 'standard' | 'untrusted', returnValue: unknown) {
        return new ToolRuntimeAdapter([{
            name: toolName,
            description: toolName,
            trustTier: tier,
            inputSchema: { type: 'object', properties: {} },
            execute: async () => returnValue,
        }]);
    }

    it('dispatches calls to the correct sub-runtime', async () => {
        const composite = new CompositeToolRuntime([
            makeRuntime('tool_a', 'trusted', 'result-a'),
            makeRuntime('tool_b', 'standard', 'result-b'),
        ]);
        const a = await composite.call('tool_a', {});
        const b = await composite.call('tool_b', {});
        expect(a.content).toBe('result-a');
        expect(b.content).toBe('result-b');
    });

    it('forwards accurate trust tier to policy', async () => {
        const seen: string[] = [];
        const policy: IToolPolicy = {
            evaluate: async (ctx: PolicyContext): Promise<PolicyDecision> => {
                seen.push(`${ctx.name}:${ctx.trustTier}`);
                return { kind: 'allow' };
            },
        };
        const composite = new CompositeToolRuntime([
            makeRuntime('internal', 'trusted', 'x'),
            makeRuntime('external', 'untrusted', 'y'),
        ], policy);
        await composite.call('internal', {});
        await composite.call('external', {});
        expect(seen).toContain('internal:trusted');
        expect(seen).toContain('external:untrusted');
    });

    it('returns ok:false for unknown tool', async () => {
        const composite = new CompositeToolRuntime([makeRuntime('known', 'standard', '')]);
        const result = await composite.call('unknown', {});
        expect(result.ok).toBe(false);
    });
});

// ── AgentRunner ────────────────────────────────────────────────

describe('AgentRunner', () => {
    function makeEngine(responses: string[]): IGraphEngine<GraphState & { input: string; messages: unknown[]; output: string }> {
        let call = 0;
        type S = GraphState & { input: string; messages: unknown[]; output: string };
        return {
            run: async (state: S) => {
                const response = responses[call++ % responses.length];
                const result: S = { ...state, output: response };
                return { state: result, snapshots: [], steps: 1 } as GraphRunResult<S>;
            },
            step: async () => { throw new Error('not used'); },
            checkpoint: () => { throw new Error('not used'); },
            resume: async () => { throw new Error('not used'); },
            deadLetterQueue: [],
        } as unknown as IGraphEngine<S>;
    }

    it('appends user message and returns TurnRecord with assistant reply', async () => {
        const engine = makeEngine(['hello back']);
        const runner = new AgentRunner({ engine, inputKey: 'input', messagesKey: 'messages', outputKey: 'output' });
        const records = await runner.prompt('hello');
        expect(records).toHaveLength(1);
        expect(records[0].modelResponse.content).toBe('hello back');
        expect(records[0].userInput).toBe('hello');
    });

    it('accumulates conversation across turns', async () => {
        const engine = makeEngine(['reply1', 'reply2']);
        const runner = new AgentRunner({ engine, inputKey: 'input', messagesKey: 'messages', outputKey: 'output' });
        await runner.prompt('turn1');
        await runner.prompt('turn2');
        const conv = runner.getConversation();
        // user, assistant, user, assistant
        expect(conv).toHaveLength(4);
        expect(conv[0]).toMatchObject({ role: 'user', content: 'turn1' });
        expect(conv[1]).toMatchObject({ role: 'assistant', content: 'reply1' });
        expect(conv[2]).toMatchObject({ role: 'user', content: 'turn2' });
        expect(conv[3]).toMatchObject({ role: 'assistant', content: 'reply2' });
    });

    it('preserves graph state between turns', async () => {
        const seenStates: unknown[] = [];
        type S = GraphState & { input: string; messages: unknown[]; output: string; counter: number };
        const engine: IGraphEngine<S> = {
            run: async (state: S) => {
                seenStates.push(state.counter);
                const result: S = { ...state, output: 'ok', counter: (state.counter ?? 0) + 1 };
                return { state: result, snapshots: [], steps: 1 } as GraphRunResult<S>;
            },
        } as unknown as IGraphEngine<S>;

        const runner = new AgentRunner({ engine, inputKey: 'input', messagesKey: 'messages', outputKey: 'output' });
        await runner.prompt('first');
        await runner.prompt('second');
        // first turn: counter was undefined (0-ish), second turn: counter should be 1
        expect(seenStates[0]).toBeUndefined(); // no prior state
        expect(seenStates[1]).toBe(1);         // carried from first run
    });

    it('preserves AssistantMessage with toolCalls when output key holds one', async () => {
        type S = GraphState & { input: string; messages: unknown[]; output: unknown };
        const assistantMsg = { role: 'assistant' as const, content: 'using tools', toolCalls: [{ id: 'c1', name: 'read', args: {} }] };
        const engine: IGraphEngine<S> = {
            run: async (state: S) => ({ state: { ...state, output: assistantMsg }, snapshots: [], steps: 1 }) as GraphRunResult<S>,
        } as unknown as IGraphEngine<S>;

        const runner = new AgentRunner({ engine, inputKey: 'input', messagesKey: 'messages', outputKey: 'output' });
        const [record] = await runner.prompt('go');
        expect(record.modelResponse.toolCalls).toHaveLength(1);
        expect(record.plan).toHaveLength(1);
        expect(record.plan[0].name).toBe('read');
    });

    it('clearSession resets conversation, history, and preserved state', async () => {
        const seenStates: unknown[] = [];
        type S = GraphState & { input: string; messages: unknown[]; output: string; counter: number };
        const engine: IGraphEngine<S> = {
            run: async (state: S) => {
                seenStates.push(state.counter);
                return { state: { ...state, output: 'ok', counter: (state.counter ?? 0) + 1 }, snapshots: [], steps: 1 } as GraphRunResult<S>;
            },
        } as unknown as IGraphEngine<S>;

        const runner = new AgentRunner({ engine, inputKey: 'input', messagesKey: 'messages', outputKey: 'output' });
        await runner.prompt('first');
        runner.clearSession();
        await runner.prompt('after clear');
        // After clear, counter should be undefined again (fresh state)
        expect(seenStates[1]).toBeUndefined();
        expect(runner.getConversation()).toHaveLength(2); // user + assistant from second session
    });
});

// ── AgentContextAssembler ──────────────────────────────────────

describe('AgentContextAssembler', () => {
    function makeAssembler(budget = 10_000) {
        return new AgentContextAssembler({ systemPrompt: 'SYS', tokenBudget: budget });
    }

    it('returns all messages when within budget', async () => {
        const assembler = makeAssembler();
        const result = await assembler.assemble({
            messages: [
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi', toolCalls: [] },
            ],
        });
        expect(result.system).toBe('SYS');
        expect(result.messages).toHaveLength(2);
    });

    it('treats assistant + matching tool_result as an atomic group', async () => {
        const assembler = makeAssembler();
        const msgs = [
            { role: 'user' as const, content: 'go' },
            { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', name: 'read', args: {} }] },
            { role: 'tool_result' as const, toolCallId: 'c1', content: 'file contents' },
        ];
        const result = await assembler.assemble({ messages: msgs });
        expect(result.messages).toHaveLength(3);
    });

    it('never splits an assistant+tool_result group when dropping', async () => {
        // Tiny budget — forces the assembler to drop old groups
        const assembler = makeAssembler(20);
        // user1 + assistant/tool_result pair + user2 — budget forces dropping user1 + the pair
        const msgs = [
            { role: 'user' as const, content: 'old user message that is somewhat long' },
            { role: 'assistant' as const, content: 'tool call', toolCalls: [{ id: 'tc1', name: 'x', args: {} }] },
            { role: 'tool_result' as const, toolCallId: 'tc1', content: 'big result that is long' },
            { role: 'user' as const, content: 'recent' },
        ];
        const result = await assembler.assemble({ messages: msgs });
        // Whatever survives must not contain the assistant without its tool_result or vice versa
        const hasAssistant = result.messages.some(m => m.role === 'assistant');
        const hasToolResult = result.messages.some(m => m.role === 'tool_result');
        expect(hasAssistant).toBe(hasToolResult); // always together or both absent
    });

    it('sticky user messages are never dropped', async () => {
        const assembler = makeAssembler(15); // tight budget
        const msgs = [
            { role: 'user' as const, content: 'keep me', sticky: true },
            { role: 'user' as const, content: 'a long disposable message that should be dropped when over budget' },
            { role: 'user' as const, content: 'recent' },
        ];
        const result = await assembler.assemble({ messages: msgs });
        expect(result.messages.some(m => m.role === 'user' && m.content === 'keep me')).toBe(true);
    });
});

// ── PlanningCapability ─────────────────────────────────────────

describe('PlanningCapability', () => {
    function makePlanningProvider(plan: unknown): ILLMProvider {
        return {
            ...fakeLLM,
            structured: async () => ({ value: plan, usage: { inputTokens: 0, outputTokens: 0 } }),
        };
    }

    type S = GraphState & { memory: string; plan: unknown };

    function baseConfig(provider: ILLMProvider) {
        return {
            provider,
            system:   'You are a planning agent.',
            prompt:   (state: Readonly<S>) => state.memory,
            schema:   {} as JsonSchema,
            stateKey: 'plan' as const,
        };
    }

    it('stores plan in state[stateKey] after beforeRun', async () => {
        const expectedPlan = { goal: 'fix bug', approach: 'read logs' };
        const cap = new PlanningCapability<S>(baseConfig(makePlanningProvider(expectedPlan)));
        const state: S = { memory: 'some context', plan: null };
        await cap.lifecycle!.beforeRun!(state);
        expect(state.plan).toEqual(expectedPlan);
    });

    it('has no prompt contributor field', () => {
        const cap = new PlanningCapability<S>(baseConfig(fakeLLM));
        expect((cap as Record<string, unknown>)['prompt']).toBeUndefined();
    });

    it('falls back to fallback value when provider throws', async () => {
        const failProvider: ILLMProvider = {
            ...fakeLLM,
            structured: async () => { throw new Error('provider error'); },
        };
        const fallback = { goal: 'default', approach: 'none' };
        const cap = new PlanningCapability<S>({ ...baseConfig(failProvider), fallback });
        const state: S = { memory: 'context', plan: null };
        await expect(cap.lifecycle!.beforeRun!(state)).resolves.toBeUndefined();
        expect(state.plan).toEqual(fallback);
    });

    it('leaves stateKey unchanged when provider throws and no fallback', async () => {
        const failProvider: ILLMProvider = {
            ...fakeLLM,
            structured: async () => { throw new Error('provider error'); },
        };
        const cap = new PlanningCapability<S>(baseConfig(failProvider));
        const state: S = { memory: 'context', plan: 'original' };
        await cap.lifecycle!.beforeRun!(state);
        expect(state.plan).toBe('original');
    });

    it('clears plan (sets undefined) after afterRun', async () => {
        const expectedPlan = { goal: 'x', approach: 'y' };
        const cap = new PlanningCapability<S>(baseConfig(makePlanningProvider(expectedPlan)));
        const state: S = { memory: 'ctx', plan: null };
        await cap.lifecycle!.beforeRun!(state);
        expect(state.plan).toEqual(expectedPlan);
        await cap.lifecycle!.afterRun!(state);
        expect(state.plan).toBeUndefined();
    });

    it('passes state projection result as user message content', async () => {
        let capturedMessages: unknown[] | undefined;
        const provider: ILLMProvider = {
            ...fakeLLM,
            structured: async (req) => {
                capturedMessages = req.messages;
                return { value: {}, usage: { inputTokens: 0, outputTokens: 0 } };
            },
        };
        const cap = new PlanningCapability<S>({
            ...baseConfig(provider),
            prompt: (state) => `context: ${state.memory}`,
        });
        const state: S = { memory: 'logs show error', plan: null };
        await cap.lifecycle!.beforeRun!(state);
        expect(capturedMessages).toHaveLength(1);
        expect((capturedMessages![0] as { content: string }).content).toBe('context: logs show error');
    });
});

// ── BudgetHintCapability ───────────────────────────────────────

describe('BudgetHintCapability', () => {
    type S = GraphState & { turnCount: number; messages: unknown[] };

    function makeTurn(): TurnRecord {
        return {
            turnId: 't1', userInput: 'hi',
            modelRequest: { messages: [] },
            modelResponse: { role: 'assistant', content: 'ok', toolCalls: [] },
            plan: [], executions: [], outcome: 'answered',
            durationMs: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
    }

    it('injects no hint below 75% threshold', async () => {
        const cap = new BudgetHintCapability<S>({ turnCountKey: 'turnCount', maxTurns: 10, messagesKey: 'messages' });
        const state: S = { turnCount: 5, messages: [] }; // 50%
        await cap.lifecycle!.afterTurn!(state, makeTurn());
        expect(state.turnCount).toBe(6);
        expect(state.messages).toHaveLength(0);
    });

    it('injects hint at 75% threshold', async () => {
        const cap = new BudgetHintCapability<S>({ turnCountKey: 'turnCount', maxTurns: 8, messagesKey: 'messages' });
        const state: S = { turnCount: 5, messages: [] }; // becomes 75%
        await cap.lifecycle!.afterTurn!(state, makeTurn());
        expect(state.turnCount).toBe(6);
        expect(state.messages).toHaveLength(1);
        const msg = state.messages[0] as { sticky?: boolean; content: string };
        expect(msg.sticky).toBe(true);
        expect(msg.content).toContain('wrap-up');
    });

    it('injects hint at 90% threshold', async () => {
        const cap = new BudgetHintCapability<S>({ turnCountKey: 'turnCount', maxTurns: 10, messagesKey: 'messages' });
        const state: S = { turnCount: 8, messages: [] }; // becomes 90%
        await cap.lifecycle!.afterTurn!(state, makeTurn());
        expect(state.turnCount).toBe(9);
        expect(state.messages).toHaveLength(1);
        expect((state.messages[0] as { content: string }).content).toContain('wrapping up');
    });

    it('injects final-turn hint at 100%', async () => {
        const cap = new BudgetHintCapability<S>({ turnCountKey: 'turnCount', maxTurns: 5, messagesKey: 'messages' });
        const state: S = { turnCount: 4, messages: [] }; // becomes 100%
        await cap.lifecycle!.afterTurn!(state, makeTurn());
        expect(state.turnCount).toBe(5);
        expect(state.messages).toHaveLength(1);
        expect((state.messages[0] as { content: string }).content).toContain('final turn');
    });

    it('each threshold fires at most once per run', async () => {
        const cap = new BudgetHintCapability<S>({ turnCountKey: 'turnCount', maxTurns: 100, messagesKey: 'messages' });
        const state: S = { turnCount: 74, messages: [] }; // becomes 75%, then 76%
        await cap.lifecycle!.afterTurn!(state, makeTurn());
        await cap.lifecycle!.afterTurn!(state, makeTurn());
        expect(state.messages).toHaveLength(1);
    });

    it('concurrent runs use separate fired sets via WeakMap', async () => {
        const cap = new BudgetHintCapability<S>({ turnCountKey: 'turnCount', maxTurns: 100, messagesKey: 'messages' });
        const stateA: S = { turnCount: 74, messages: [] }; // becomes 75%
        const stateB: S = { turnCount: 74, messages: [] }; // becomes 75%
        // Both independent state objects should each receive their own hint
        await cap.lifecycle!.afterTurn!(stateA, makeTurn());
        await cap.lifecycle!.afterTurn!(stateB, makeTurn());
        expect(stateA.messages).toHaveLength(1);
        expect(stateB.messages).toHaveLength(1);
        // Firing again on stateA should not re-inject (threshold already fired for this state)
        await cap.lifecycle!.afterTurn!(stateA, makeTurn());
        expect(stateA.messages).toHaveLength(1);
    });
});

// ── EmptyResponseCapability ────────────────────────────────────

describe('EmptyResponseCapability', () => {
    type S = GraphState & { messages: unknown[]; emptyCount: number; done?: boolean };

    function makeTurn(content: string, toolCalls: unknown[] = []): TurnRecord {
        return {
            turnId: 't1', userInput: null,
            modelRequest: { messages: [] },
            modelResponse: { role: 'assistant', content, toolCalls: toolCalls as never },
            plan: [], executions: [], outcome: 'answered',
            durationMs: 1, tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
    }

    it('does nothing on non-empty turn', async () => {
        const cap = new EmptyResponseCapability<S>({ messagesKey: 'messages', emptyCountKey: 'emptyCount' });
        const state: S = { messages: [], emptyCount: 0 };
        await cap.lifecycle!.afterTurn!(state, makeTurn('hello'));
        expect(state.messages).toHaveLength(0);
        expect(state.emptyCount).toBe(0);
    });

    it('injects nudge on empty turn', async () => {
        const cap = new EmptyResponseCapability<S>({ messagesKey: 'messages', emptyCountKey: 'emptyCount', maxRetries: 2 });
        const state: S = { messages: [], emptyCount: 0 };
        await cap.lifecycle!.afterTurn!(state, makeTurn(''));
        expect(state.messages).toHaveLength(1);
        const msg = state.messages[0] as { sticky?: boolean; content: string };
        expect(msg.sticky).toBe(true);
        expect(state.emptyCount).toBe(1);
    });

    it('uses mid-run nudge when recent messages contain tool_result', async () => {
        const cap = new EmptyResponseCapability<S>({
            messagesKey:   'messages',
            emptyCountKey: 'emptyCount',
            nudgeMidRun:   'MID_RUN_NUDGE',
            nudgeFinal:    'FINAL_NUDGE',
        });
        const state: S = {
            messages:   [{ role: 'tool_result', toolCallId: 'x', content: 'result' }],
            emptyCount: 0,
        };
        await cap.lifecycle!.afterTurn!(state, makeTurn(''));
        const last = state.messages[state.messages.length - 1] as { content: string };
        expect(last.content).toBe('MID_RUN_NUDGE');
    });

    it('uses final nudge when no recent tool_results', async () => {
        const cap = new EmptyResponseCapability<S>({
            messagesKey:   'messages',
            emptyCountKey: 'emptyCount',
            nudgeMidRun:   'MID_RUN_NUDGE',
            nudgeFinal:    'FINAL_NUDGE',
        });
        const state: S = { messages: [{ role: 'user', content: 'go' }], emptyCount: 0 };
        await cap.lifecycle!.afterTurn!(state, makeTurn(''));
        const last = state.messages[state.messages.length - 1] as { content: string };
        expect(last.content).toBe('FINAL_NUDGE');
    });

    it('resets counter on non-empty turn', async () => {
        const cap = new EmptyResponseCapability<S>({ messagesKey: 'messages', emptyCountKey: 'emptyCount', maxRetries: 2 });
        const state: S = { messages: [], emptyCount: 0 };
        await cap.lifecycle!.afterTurn!(state, makeTurn('')); // empty #1 → count 1
        await cap.lifecycle!.afterTurn!(state, makeTurn('ok')); // non-empty → count 0
        await cap.lifecycle!.afterTurn!(state, makeTurn('')); // empty #1 again → count 1
        // Should have 2 nudge messages (not 3)
        expect(state.messages.filter((m: unknown) => (m as { role: string }).role === 'user')).toHaveLength(2);
        expect(state.emptyCount).toBe(1);
    });

    it('sets stopKey after maxRetries exceeded', async () => {
        const cap = new EmptyResponseCapability<S>({
            messagesKey:   'messages',
            emptyCountKey: 'emptyCount',
            stopKey:       'done',
            maxRetries:    1,
        });
        const state: S = { messages: [], emptyCount: 0, done: false };
        await cap.lifecycle!.afterTurn!(state, makeTurn('')); // empty #1 — nudge
        await cap.lifecycle!.afterTurn!(state, makeTurn('')); // empty #2 — exceeded
        expect(state.done).toBe(true);
    });

    it('counter resets when a fresh state object is used (new run)', async () => {
        const cap = new EmptyResponseCapability<S>({
            messagesKey:   'messages',
            emptyCountKey: 'emptyCount',
            stopKey:       'done',
            maxRetries:    1,
        });
        // First run: exhaust retries
        const stateRun1: S = { messages: [], emptyCount: 0, done: false };
        await cap.lifecycle!.afterTurn!(stateRun1, makeTurn('')); // empty #1 — nudge
        await cap.lifecycle!.afterTurn!(stateRun1, makeTurn('')); // empty #2 — exceeded
        expect(stateRun1.done).toBe(true);
        // Second run: fresh state → counter starts from 0, first empty turn nudges not terminates
        const stateRun2: S = { messages: [], emptyCount: 0, done: false };
        await cap.lifecycle!.afterTurn!(stateRun2, makeTurn('')); // empty #1 — nudge
        expect(stateRun2.done).toBe(false);
        expect(stateRun2.messages).toHaveLength(1);
    });
});
