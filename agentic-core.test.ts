/**
 * agentic-core library tests.
 *
 * Standalone tests for the generic primitives extracted from Aquarium.
 * These tests don't depend on Aquarium, Container, or any domain code.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    PromptEngine,
    PromptContributorRegistry,
    TickPipeline,
    InMemoryTracer,
    CapabilityRegistry,
    MigrationOrchestrator,
    InMemoryMigrationState,
    AIPromptService,
    AIPipeline,
    estimateTokens,
} from './index.js';

import type {
    PromptSection,
    ITickStep,
    IPackManifest,
    ILLMProvider,
    LLMRequest,
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
    async process<T>(req: LLMRequest<T>): Promise<T> {
        return { response: `echo: ${req.text}` } as unknown as T;
    },
    async embed(_text: string): Promise<number[]> {
        return [0.1, 0.2, 0.3];
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

        await pipeline.run('sim1', { simulationId: 'sim1', tick: 1, stepState: {} });
        expect(log).toEqual(['b', 'a']); // order 10 before 20
    });

    it('throws on empty pipeline', async () => {
        const pipeline = new TickPipeline();
        await expect(
            pipeline.run('sim1', { simulationId: 'sim1', tick: 1, stepState: {} })
        ).rejects.toThrow('No tick steps registered');
    });

    it('replaces step with same id', () => {
        const pipeline = new TickPipeline();
        pipeline.registerStep({ id: 'x', order: 1, execute: async () => {} });
        pipeline.registerStep({ id: 'x', order: 2, execute: async () => {} });
        expect(pipeline.listSteps()).toHaveLength(1);
        expect(pipeline.listSteps()[0].order).toBe(2);
    });
});

// ── InMemoryTracer ─────────────────────────────────────────────

describe('InMemoryTracer', () => {
    it('traces and queries recent events', () => {
        const tracer = new InMemoryTracer(100);
        tracer.trace({ simulationId: 's1', type: 'test', timestamp: 1, data: { a: 1 } });
        tracer.trace({ simulationId: 's1', type: 'test', timestamp: 2, data: { a: 2 } });
        tracer.trace({ simulationId: 's2', type: 'test', timestamp: 3, data: {} });

        const recent = tracer.recent('s1', 10);
        expect(recent).toHaveLength(2);
        expect(recent[0].timestamp).toBe(2); // most recent first
    });

    it('ring buffer drops oldest', () => {
        const tracer = new InMemoryTracer(2);
        tracer.trace({ simulationId: 's1', type: 'a', timestamp: 1, data: {} });
        tracer.trace({ simulationId: 's1', type: 'b', timestamp: 2, data: {} });
        tracer.trace({ simulationId: 's1', type: 'c', timestamp: 3, data: {} });

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
});

// ── MigrationOrchestrator ──────────────────────────────────────

describe('MigrationOrchestrator', () => {
    it('runs unapplied migrations and skips applied ones', async () => {
        const state = new InMemoryMigrationState();
        const log: string[] = [];
        const orch = new MigrationOrchestrator(state, null);

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
        const calls: LLMRequest[] = [];
        const spyLLM: ILLMProvider = {
            async process<T>(req: LLMRequest<T>): Promise<T> {
                calls.push(req);
                return { response: 'ok' } as unknown as T;
            },
            async embed() { return []; },
        };

        const svc = new AIPromptService(spyLLM);
        await svc.use().system('sys1').system('sys2').user('u1').user('u2').run();

        expect(calls[0].instructions).toBe('sys1\n\nsys2');
        expect(calls[0].text).toBe('u1\n\nu2');
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
});
