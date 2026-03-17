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
    CapabilityRegistry,
    PackMigrationRunner,
    InMemoryMigrationState,
    AIPromptService,
    AIPipeline,
    ToolRegistry,
    InMemoryStore,
    ToolPromptRenderer,
    ContextAssembler,
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

        const stepA: ITickStep = { id: 'a', order: 20, execute: async () => { log.push('a'); } };
        const stepB: ITickStep = { id: 'b', order: 10, execute: async () => { log.push('b'); } };

        pipeline.registerStep(stepA);
        pipeline.registerStep(stepB);

        await pipeline.run('sim1', { correlationId: 'sim1', tick: 1, stepState: {} });
        expect(log).toEqual(['b', 'a']); // order 10 before 20
    });

    it('throws on empty pipeline', async () => {
        const pipeline = new TickPipeline();
        await expect(
            pipeline.run('sim1', { correlationId: 'sim1', tick: 1, stepState: {} })
        ).rejects.toThrow('No tick steps registered');
    });

    it('replaces step with same id', () => {
        const pipeline = new TickPipeline();
        pipeline.registerStep({ id: 'x', order: 1, execute: async () => {} });
        pipeline.registerStep({ id: 'x', order: 2, execute: async () => {} });
        expect(pipeline.listSteps()).toHaveLength(1);
        expect(pipeline.listSteps()[0].order).toBe(2);
    });

    it('resolveStep returns step by id, null for unknown', () => {
        const pipeline = new TickPipeline();
        const step: ITickStep = { id: 'alpha', order: 1, execute: async () => {} };
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

// ── CapabilityRegistry ─────────────────────────────────────────

describe('CapabilityRegistry', () => {
    it('registers and lists manifests', () => {
        const reg = new CapabilityRegistry();
        reg.registerManifest(manifest('a'));
        reg.registerManifest(manifest('b'));
        expect(reg.listManifests()).toHaveLength(2);
        expect(reg.getManifest('a')?.id).toBe('a');
        expect(reg.getManifest('z')).toBeNull();
    });

    it('validates missing dependencies', () => {
        const reg = new CapabilityRegistry();
        reg.registerManifest(manifest('a', ['svc-a'], []));
        reg.registerManifest(manifest('b', [], ['svc-x'])); // requires missing svc-x

        const errors = reg.validateDependencies(['a', 'b']);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].message).toContain('svc-x');
    });

    it('resolves boot order respecting dependencies', () => {
        const reg = new CapabilityRegistry();
        reg.registerManifest(manifest('db', ['database'], []));
        reg.registerManifest(manifest('app', [], ['database']));

        const order = reg.resolveBootOrder(['db', 'app']);
        expect(order.map((m: IPackManifest) => m.id)).toEqual(['db', 'app']);
    });

    it('detects circular dependencies', () => {
        const reg = new CapabilityRegistry();
        reg.registerManifest(manifest('a', ['svc-a'], ['svc-b']));
        reg.registerManifest(manifest('b', ['svc-b'], ['svc-a']));

        expect(() => reg.resolveBootOrder(['a', 'b'])).toThrow('Circular dependency');
    });

    it('validateDependencies returns error for unregistered pack', () => {
        const reg = new CapabilityRegistry();
        // 'ghost' is not registered but is listed as enabled
        const errors = reg.validateDependencies(['ghost']);
        expect(errors).toHaveLength(1);
        expect(errors[0].packId).toBe('ghost');
        expect(errors[0].message).toContain('not registered');
    });

    it('validateDependencies returns error for duplicate token providers', () => {
        const reg = new CapabilityRegistry();
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
