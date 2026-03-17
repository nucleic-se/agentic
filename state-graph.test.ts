/**
 * State graph engine tests.
 *
 * Covers: graph structure, engine execution, conditional routing,
 * cycle detection, dead letter queue, builder API, built-in nodes,
 * and LLM integration.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    StateGraph,
    StateGraphEngine,
    StateGraphBuilder,
    CallbackGraphNode,
    LlmGraphNode,
    SubGraphNode,
    InMemoryTracer,
    InMemorySpanTracer,
} from './index.js';
import { END } from './contracts/index.js';
import type { IGraphNode, GraphContext, ILLMProvider, StructuredRequest, TurnRequest, GraphStepResult } from './index.js';

// ── Helpers ────────────────────────────────────────────────────

interface CounterState extends Record<string, unknown> {
    count: number;
    log: string[];
}

interface ResearchState extends Record<string, unknown> {
    topic: string;
    plan: string;
    sources: string;
    critique: string;
    approved: boolean;
    draft: string;
}

const fakeLLM: ILLMProvider = {
    async structured(req: StructuredRequest) {
        const text = req.messages.map(m => typeof m.content === 'string' ? m.content : '').join('');
        return { value: `llm:${text}`, usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async turn(req) {
        const text = req.messages.map(m => typeof m.content === 'string' ? m.content : '').join('');
        return {
            message: { role: 'assistant' as const, content: `llm:${text}`, toolCalls: [] },
            stopReason: 'end_turn' as const,
            usage: { inputTokens: 0, outputTokens: 0 },
        };
    },
    async embed() { return [[0.1, 0.2]]; },
};

// ── StateGraph (structure) ─────────────────────────────────────

describe('StateGraph', () => {
    it('adds and retrieves nodes', () => {
        const graph = new StateGraph();
        const node = new CallbackGraphNode('a', async () => {});
        graph.addNode(node);

        expect(graph.getNode('a')).toBe(node);
        expect(graph.getNode('missing')).toBeUndefined();
    });

    it('throws on duplicate node ID', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        expect(() => graph.addNode(new CallbackGraphNode('a', async () => {}))).toThrow(
            "Node 'a' already exists",
        );
    });

    it('lists all nodes', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        graph.addNode(new CallbackGraphNode('b', async () => {}));
        expect(graph.getNodes()).toHaveLength(2);
    });

    it('adds static edges', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        graph.addNode(new CallbackGraphNode('b', async () => {}));
        graph.addEdge('a', 'b');
        expect(graph.getStaticEdge('a')).toBe('b');
    });

    it('adds edge to END', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        graph.addEdge('a', END);
        expect(graph.getStaticEdge('a')).toBe(END);
    });

    it('throws when edge source does not exist', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('b', async () => {}));
        expect(() => graph.addEdge('missing', 'b')).toThrow("Node 'missing' does not exist");
    });

    it('throws when edge target does not exist', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        expect(() => graph.addEdge('a', 'missing')).toThrow("Node 'missing' does not exist");
    });

    it('throws when node already has an outbound edge', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        graph.addNode(new CallbackGraphNode('b', async () => {}));
        graph.addNode(new CallbackGraphNode('c', async () => {}));
        graph.addEdge('a', 'b');
        expect(() => graph.addEdge('a', 'c')).toThrow("Node 'a' already has an outbound edge");
    });

    it('throws when adding conditional edge over existing static', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        graph.addNode(new CallbackGraphNode('b', async () => {}));
        graph.addEdge('a', 'b');
        expect(() => graph.addConditionalEdge('a', () => END)).toThrow(
            "Node 'a' already has an outbound edge",
        );
    });

    it('adds conditional edges', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        const router = () => END;
        graph.addConditionalEdge('a', router);
        expect(graph.getConditionalEdge('a')).toBe(router);
        expect(graph.getStaticEdge('a')).toBeUndefined();
    });

    it('sets and retrieves entry node', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('start', async () => {}));
        graph.setEntry('start');
        expect(graph.getEntryNodeId()).toBe('start');
    });

    it('throws when setting entry to non-existent node', () => {
        const graph = new StateGraph();
        expect(() => graph.setEntry('missing')).toThrow("Node 'missing' does not exist");
    });
});

// ── StateGraphEngine ───────────────────────────────────────────

describe('StateGraphEngine', () => {
    it('executes a single node and returns state', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('inc', async (state) => {
            state.count++;
        }));
        graph.setEntry('inc');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(1);
        expect(result.steps).toBe(1);
        expect(result.snapshots).toHaveLength(1);
        expect(result.snapshots[0].nodeId).toBe('inc');
    });

    it('executes a linear chain of nodes', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.log.push('a'); s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.log.push('b'); s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('c', async (s) => { s.log.push('c'); s.count++; }));
        graph.addEdge('a', 'b');
        graph.addEdge('b', 'c');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(3);
        expect(result.state.log).toEqual(['a', 'b', 'c']);
        expect(result.steps).toBe(3);
    });

    it('stops at explicit END edge', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count = 1; }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count = 99; }));
        graph.addEdge('a', END);
        graph.addEdge('b', END); // unreachable
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(1);
        expect(result.steps).toBe(1);
    });

    it('stops at implicit END (no outbound edge)', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('only', async (s) => { s.count = 42; }));
        graph.setEntry('only');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(42);
        expect(result.steps).toBe(1);
    });

    it('does not mutate the caller\'s initial state', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('mutate', async (s) => { s.count = 999; }));
        graph.setEntry('mutate');

        const initial: CounterState = { count: 0, log: [] };
        const engine = new StateGraphEngine(graph);
        await engine.run(initial);

        expect(initial.count).toBe(0);
    });

    it('throws when no entry node is set', async () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({})).rejects.toThrow('No entry node set');
    });

    it('snapshots state after each node (deep cloned)', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('first', async (s) => { s.count = 1; }));
        graph.addNode(new CallbackGraphNode<CounterState>('second', async (s) => { s.count = 2; }));
        graph.addEdge('first', 'second');
        graph.setEntry('first');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.snapshots).toHaveLength(2);
        expect(result.snapshots[0].state.count).toBe(1);
        expect(result.snapshots[1].state.count).toBe(2);
        // Snapshots are independent deep clones
        expect(result.snapshots[0].state).not.toBe(result.snapshots[1].state);
    });

    it('traces step events', async () => {
        const tracer = new InMemoryTracer(50);
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; }));
        graph.addEdge('a', 'b');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'graph' });
        await engine.run({ count: 0, log: [] });

        const events = tracer.recent('graph', 10);
        expect(events.length).toBe(2);
        expect(events.map(e => e.type)).toEqual(['graph.step', 'graph.step']);
    });
});

// ── Conditional Routing ────────────────────────────────────────

describe('Conditional Routing', () => {
    it('follows conditional edge based on state', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('check', async (s) => { /* read-only */ }));
        graph.addNode(new CallbackGraphNode<CounterState>('high', async (s) => { s.log.push('high'); }));
        graph.addNode(new CallbackGraphNode<CounterState>('low', async (s) => { s.log.push('low'); }));
        graph.addConditionalEdge('check', (s) => s.count > 5 ? 'high' : 'low');
        graph.setEntry('check');

        const engine = new StateGraphEngine(graph);

        const r1 = await engine.run({ count: 10, log: [] });
        expect(r1.state.log).toEqual(['high']);

        const engine2 = new StateGraphEngine(graph);
        const r2 = await engine2.run({ count: 1, log: [] });
        expect(r2.state.log).toEqual(['low']);
    });

    it('conditional edge can return END', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('gate', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('unreachable', async (s) => { s.count = 999; }));
        graph.addConditionalEdge('gate', () => END);
        graph.setEntry('gate');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(0);
        expect(result.steps).toBe(1);
    });
});

// ── Cycles & Safety ────────────────────────────────────────────

describe('Cycles & Safety', () => {
    it('enforces maxSteps and throws', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('loop', async (s) => { s.count++; }));
        graph.addEdge('loop', 'loop'); // self-loop
        graph.setEntry('loop');

        const engine = new StateGraphEngine(graph, { maxSteps: 5 });
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('Max steps (5) exceeded');
    });

    it('defaults maxSteps to 100', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('loop', async (s) => { s.count++; }));
        graph.addEdge('loop', 'loop');
        graph.setEntry('loop');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('Max steps (100) exceeded');
    });

    it('allows controlled cycles with an exit condition', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('iterate', async (s) => {
            s.count++;
            s.log.push(`iter-${s.count}`);
        }));
        graph.addConditionalEdge('iterate', (s) => s.count >= 3 ? END : 'iterate');
        graph.setEntry('iterate');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(3);
        expect(result.state.log).toEqual(['iter-1', 'iter-2', 'iter-3']);
        expect(result.steps).toBe(3);
    });

    it('multi-node cycle with conditional exit', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('process', async (s) => { s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('review', async (s) => { s.log.push(`review-${s.count}`); }));
        graph.addEdge('process', 'review');
        graph.addConditionalEdge('review', (s) => s.count >= 2 ? END : 'process');
        graph.setEntry('process');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });

        expect(result.state.count).toBe(2);
        expect(result.state.log).toEqual(['review-1', 'review-2']);
        expect(result.steps).toBe(4); // process, review, process, review
    });
});

// ── Error Handling & DLQ ───────────────────────────────────────

describe('Error Handling', () => {
    it('pushes error to DLQ and re-throws', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('faulty', async () => {
            throw new Error('boom');
        }));
        graph.setEntry('faulty');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('boom');

        expect(engine.deadLetterQueue).toHaveLength(1);
        expect(engine.deadLetterQueue[0].nodeId).toBe('faulty');
        expect(engine.deadLetterQueue[0].error.message).toBe('boom');
    });

    it('DLQ contains pre-execution state snapshot', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('setup', async (s) => { s.count = 42; }));
        graph.addNode(new CallbackGraphNode<CounterState>('faulty', async (s) => {
            s.count = 999; // partial mutation before throw
            throw new Error('fail');
        }));
        graph.addEdge('setup', 'faulty');
        graph.setEntry('setup');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('fail');

        const dlq = engine.deadLetterQueue[0];
        expect(dlq.nodeId).toBe('faulty');
        // DLQ stores PRE-execution state (count=42 from 'setup', not 999)
        expect((dlq.state as CounterState).count).toBe(42);
    });

    it('traces error events', async () => {
        const tracer = new InMemoryTracer(50);
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('faulty', async () => {
            throw new Error('traced-error');
        }));
        graph.setEntry('faulty');

        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'graph' });
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow();

        const events = tracer.recent('graph', 10);
        expect(events.some(e => e.type === 'graph.error')).toBe(true);
    });
});

// ── StateGraphBuilder ──────────────────────────────────────────

describe('StateGraphBuilder', () => {
    it('builds and runs a graph fluently', async () => {
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; s.log.push('a'); }))
            .addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; s.log.push('b'); }))
            .setEntry('a')
            .addEdge('a', 'b')
            .addEdge('b', END)
            .build();

        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(2);
        expect(result.state.log).toEqual(['a', 'b']);
    });

    it('supports conditional edges in builder', async () => {
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('tick', async (s) => { s.count++; }))
            .setEntry('tick')
            .addConditionalEdge('tick', (s) => s.count >= 3 ? END : 'tick')
            .build({ maxSteps: 10 });

        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(3);
    });

    it('passes engine config through build()', async () => {
        const tracer = new InMemoryTracer(50);
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }))
            .setEntry('a')
            .build({ maxSteps: 50, tracer, correlationId: 'graph' });

        await engine.run({ count: 0, log: [] });
        expect(tracer.recent('graph', 10)).toHaveLength(1);
    });
});

// ── Built-in Nodes ─────────────────────────────────────────────

describe('CallbackGraphNode', () => {
    it('executes callback with state and context', async () => {
        const node = new CallbackGraphNode<CounterState>('test', async (state, ctx) => {
            state.log.push(`node:${ctx.nodeId}:step:${ctx.stepCount}`);
        });

        const graph = new StateGraph<CounterState>();
        graph.addNode(node);
        graph.setEntry('test');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.log).toEqual(['node:test:step:0']);
    });

    it('supports synchronous callbacks', async () => {
        const node = new CallbackGraphNode<CounterState>('sync', (state) => {
            state.count = 42;
        });

        const graph = new StateGraph<CounterState>();
        graph.addNode(node);
        graph.setEntry('sync');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(42);
    });
});

describe('LlmGraphNode', () => {
    it('calls LLM and writes result to state', async () => {
        const node = new LlmGraphNode<ResearchState>({
            id: 'research',
            provider: fakeLLM,
            prompt: (s) => ({
                instructions: 'Find sources.',
                text: s.topic,
            }),
            outputKey: 'sources',
        });

        const graph = new StateGraph<ResearchState>();
        graph.addNode(node);
        graph.setEntry('research');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({
            topic: 'quantum computing',
            plan: '',
            sources: '',
            critique: '',
            approved: false,
            draft: '',
        });

        expect(result.state.sources).toBe('llm:quantum computing');
    });

    it('passes system and message content to structured()', async () => {
        const calls: StructuredRequest[] = [];
        const spyLLM: ILLMProvider = {
            async structured(req: StructuredRequest) {
                calls.push(req);
                return { value: 'result', usage: { inputTokens: 0, outputTokens: 0 } };
            },
            async turn() {
                return {
                    message: { role: 'assistant' as const, content: 'ok', toolCalls: [] },
                    stopReason: 'end_turn' as const,
                    usage: { inputTokens: 0, outputTokens: 0 },
                };
            },
            async embed() { return []; },
        };

        const node = new LlmGraphNode<ResearchState>({
            id: 'llm',
            provider: spyLLM,
            prompt: (s) => ({ instructions: 'be helpful', text: s.topic, schema: { type: 'object' } }),
            outputKey: 'plan',
        });

        const graph = new StateGraph<ResearchState>();
        graph.addNode(node);
        graph.setEntry('llm');

        const engine = new StateGraphEngine(graph);
        await engine.run({
            topic: 'test',
            plan: '',
            sources: '',
            critique: '',
            approved: false,
            draft: '',
        });

        expect(calls[0].system).toBe('be helpful');
        expect(calls[0].messages[0]).toMatchObject({ role: 'user', content: 'test' });
    });

    it('calls turn() and not structured() when no schema is present', async () => {
        const turnCalls: TurnRequest[] = [];
        const structuredCalls: StructuredRequest[] = [];
        const spyLLM: ILLMProvider = {
            async structured(req) {
                structuredCalls.push(req);
                return { value: 'structured', usage: { inputTokens: 0, outputTokens: 0 } };
            },
            async turn(req) {
                turnCalls.push(req);
                return {
                    message: { role: 'assistant' as const, content: 'plain text result', toolCalls: [] },
                    stopReason: 'end_turn' as const,
                    usage: { inputTokens: 0, outputTokens: 0 },
                };
            },
            async embed() { return []; },
        };

        const node = new LlmGraphNode<ResearchState>({
            id: 'llm',
            provider: spyLLM,
            prompt: (s) => ({ instructions: 'be helpful', text: s.topic }),
            outputKey: 'sources',
        });

        const graph = new StateGraph<ResearchState>();
        graph.addNode(node);
        graph.setEntry('llm');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({
            topic: 'test topic',
            plan: '', sources: '', critique: '', approved: false, draft: '',
        });

        expect(structuredCalls).toHaveLength(0);
        expect(turnCalls).toHaveLength(1);
        expect(turnCalls[0].system).toBe('be helpful');
        expect(turnCalls[0].messages[0]).toMatchObject({ role: 'user', content: 'test topic' });
        expect(result.state.sources).toBe('plain text result');
    });

    it('forwards prompt-level schema to structured()', async () => {
        const calls: StructuredRequest[] = [];
        const spyLLM: ILLMProvider = {
            async structured(req) {
                calls.push(req);
                return { value: { answer: 42 }, usage: { inputTokens: 0, outputTokens: 0 } };
            },
            async turn() {
                return {
                    message: { role: 'assistant' as const, content: 'text', toolCalls: [] },
                    stopReason: 'end_turn' as const,
                    usage: { inputTokens: 0, outputTokens: 0 },
                };
            },
            async embed() { return []; },
        };

        const promptSchema = {
            type: 'object' as const,
            properties: { answer: { type: 'number' } },
            required: ['answer'],
        };

        const node = new LlmGraphNode<ResearchState>({
            id: 'llm',
            provider: spyLLM,
            prompt: () => ({ instructions: 'answer', text: 'q', schema: promptSchema }),
            outputKey: 'plan',
        });

        const graph = new StateGraph<ResearchState>();
        graph.addNode(node);
        graph.setEntry('llm');

        const engine = new StateGraphEngine(graph);
        await engine.run({
            topic: '', plan: '', sources: '', critique: '', approved: false, draft: '',
        });

        expect(calls).toHaveLength(1);
        expect(calls[0].schema).toBe(promptSchema);
    });
});

// ── Integration: LLM Agent Loop ───────────────────────────────

describe('LLM Agent Loop (integration)', () => {
    it('plan → research → critique → revise loop', async () => {
        let critiqueCount = 0;

        const engine = new StateGraphBuilder<ResearchState>()
            .addNode(new CallbackGraphNode<ResearchState>('plan', async (s) => {
                s.plan = `Plan for: ${s.topic}`;
            }))
            .addNode(new LlmGraphNode<ResearchState>({
                id: 'research',
                provider: fakeLLM,
                prompt: (s) => ({ instructions: s.plan, text: s.topic }),
                outputKey: 'sources',
            }))
            .addNode(new CallbackGraphNode<ResearchState>('critique', async (s) => {
                critiqueCount++;
                s.critique = `Critique #${critiqueCount}`;
                s.approved = critiqueCount >= 2;
            }))
            .addNode(new CallbackGraphNode<ResearchState>('write', async (s) => {
                s.draft = `Draft based on: ${s.sources}`;
            }))
            .setEntry('plan')
            .addEdge('plan', 'research')
            .addEdge('research', 'critique')
            .addConditionalEdge('critique', (s) => s.approved ? 'write' : 'research')
            .addEdge('write', END)
            .build({ maxSteps: 20 });

        const result = await engine.run({
            topic: 'quantum computing',
            plan: '',
            sources: '',
            critique: '',
            approved: false,
            draft: '',
        });

        expect(result.state.approved).toBe(true);
        expect(result.state.draft).toContain('llm:quantum computing');
        expect(result.state.critique).toBe('Critique #2');
        // plan → research → critique → research → critique → write = 6 steps
        expect(result.steps).toBe(6);
    });
});

// ── SubGraphNode ───────────────────────────────────────────────

interface SubResearchState extends Record<string, unknown> {
    query: string;
    sources: string;
    summary: string;
}

interface ArticleState extends Record<string, unknown> {
    topic: string;
    summary: string;
    draft: string;
}

describe('SubGraphNode', () => {
    function buildResearchEngine() {
        return new StateGraphBuilder<SubResearchState>()
            .addNode(new CallbackGraphNode<SubResearchState>('search', async (s) => {
                s.sources = `sources for: ${s.query}`;
            }))
            .addNode(new CallbackGraphNode<SubResearchState>('summarize', async (s) => {
                s.summary = `summary of ${s.sources}`;
            }))
            .setEntry('search')
            .addEdge('search', 'summarize')
            .addEdge('summarize', END)
            .build();
    }

    it('runs a sub-graph and maps state back to parent', async () => {
        const researchEngine = buildResearchEngine();

        const engine = new StateGraphBuilder<ArticleState>()
            .addNode(new SubGraphNode<ArticleState, SubResearchState>({
                id: 'research',
                engine: researchEngine,
                input: (parent) => ({ query: parent.topic, sources: '', summary: '' }),
                output: (sub, parent) => { parent.summary = sub.summary; },
            }))
            .addNode(new CallbackGraphNode<ArticleState>('write', async (s) => {
                s.draft = `Article about ${s.topic}: ${s.summary}`;
            }))
            .setEntry('research')
            .addEdge('research', 'write')
            .addEdge('write', END)
            .build();

        const result = await engine.run({ topic: 'quantum computing', summary: '', draft: '' });

        expect(result.state.summary).toBe('summary of sources for: quantum computing');
        expect(result.state.draft).toBe('Article about quantum computing: summary of sources for: quantum computing');
        expect(result.steps).toBe(2); // research (sub-graph runs internally), write
    });

    it('does not mutate parent state during sub-graph input mapping', async () => {
        const researchEngine = buildResearchEngine();

        const engine = new StateGraphBuilder<ArticleState>()
            .addNode(new SubGraphNode<ArticleState, SubResearchState>({
                id: 'research',
                engine: researchEngine,
                input: (parent) => ({ query: parent.topic, sources: '', summary: '' }),
                output: (sub, parent) => { parent.summary = sub.summary; },
            }))
            .setEntry('research')
            .build();

        const initial: ArticleState = { topic: 'test', summary: '', draft: '' };
        await engine.run(initial);

        // Original not mutated (engine clones, but double-check sub-graph doesn't leak)
        expect(initial.summary).toBe('');
    });

    it('exposes lastRunResult for sub-graph inspection', async () => {
        const researchEngine = buildResearchEngine();
        const subNode = new SubGraphNode<ArticleState, SubResearchState>({
            id: 'research',
            engine: researchEngine,
            input: (parent) => ({ query: parent.topic, sources: '', summary: '' }),
            output: (sub, parent) => { parent.summary = sub.summary; },
        });

        const engine = new StateGraphBuilder<ArticleState>()
            .addNode(subNode)
            .setEntry('research')
            .build();

        await engine.run({ topic: 'test', summary: '', draft: '' });

        expect(subNode.lastRunResult).toBeDefined();
        expect(subNode.lastRunResult!.steps).toBe(2); // search + summarize
        expect(subNode.lastRunResult!.snapshots).toHaveLength(2);
        expect(subNode.lastRunResult!.state.summary).toBe('summary of sources for: test');
    });

    it('propagates sub-graph errors to parent', async () => {
        const failEngine = new StateGraphBuilder<SubResearchState>()
            .addNode(new CallbackGraphNode<SubResearchState>('fail', async () => {
                throw new Error('sub-graph boom');
            }))
            .setEntry('fail')
            .build();

        const engine = new StateGraphBuilder<ArticleState>()
            .addNode(new SubGraphNode<ArticleState, SubResearchState>({
                id: 'research',
                engine: failEngine,
                input: (p) => ({ query: p.topic, sources: '', summary: '' }),
                output: () => {},
            }))
            .setEntry('research')
            .build();

        await expect(engine.run({ topic: 'test', summary: '', draft: '' }))
            .rejects.toThrow('sub-graph boom');
    });

    it('sub-graph has independent maxSteps budget', async () => {
        // Sub-graph with a cycle and its own maxSteps
        const loopEngine = new StateGraphBuilder<SubResearchState>()
            .addNode(new CallbackGraphNode<SubResearchState>('loop', async (s) => {
                s.sources += '.';
            }))
            .setEntry('loop')
            .addEdge('loop', 'loop')
            .build({ maxSteps: 5 });

        const engine = new StateGraphBuilder<ArticleState>()
            .addNode(new SubGraphNode<ArticleState, SubResearchState>({
                id: 'research',
                engine: loopEngine,
                input: (p) => ({ query: p.topic, sources: '', summary: '' }),
                output: () => {},
            }))
            .setEntry('research')
            .build({ maxSteps: 100 }); // parent has plenty of budget

        // Sub-graph hits its own maxSteps limit
        await expect(engine.run({ topic: 'test', summary: '', draft: '' }))
            .rejects.toThrow('Max steps (5) exceeded');
    });

    it('nested sub-graphs (sub-graph within sub-graph)', async () => {
        // Inner sub-graph: search
        const innerEngine = new StateGraphBuilder<SubResearchState>()
            .addNode(new CallbackGraphNode<SubResearchState>('deep-search', async (s) => {
                s.sources = `deep:${s.query}`;
            }))
            .setEntry('deep-search')
            .build();

        // Middle sub-graph: orchestrates inner + summarize
        interface MiddleState extends Record<string, unknown> {
            query: string;
            sources: string;
            summary: string;
        }

        const middleEngine = new StateGraphBuilder<MiddleState>()
            .addNode(new SubGraphNode<MiddleState, SubResearchState>({
                id: 'inner-search',
                engine: innerEngine,
                input: (m) => ({ query: m.query, sources: '', summary: '' }),
                output: (sub, m) => { m.sources = sub.sources; },
            }))
            .addNode(new CallbackGraphNode<MiddleState>('summarize', async (s) => {
                s.summary = `summarized:${s.sources}`;
            }))
            .setEntry('inner-search')
            .addEdge('inner-search', 'summarize')
            .build();

        // Outer graph
        const engine = new StateGraphBuilder<ArticleState>()
            .addNode(new SubGraphNode<ArticleState, MiddleState>({
                id: 'research',
                engine: middleEngine,
                input: (p) => ({ query: p.topic, sources: '', summary: '' }),
                output: (sub, p) => { p.summary = sub.summary; },
            }))
            .addNode(new CallbackGraphNode<ArticleState>('write', async (s) => {
                s.draft = s.summary;
            }))
            .setEntry('research')
            .addEdge('research', 'write')
            .build();

        const result = await engine.run({ topic: 'physics', summary: '', draft: '' });
        expect(result.state.draft).toBe('summarized:deep:physics');
    });
});

// ── Hardening: Input Validation ────────────────────────────────

describe('Input Validation', () => {
    it('StateGraph rejects empty node ID', () => {
        const graph = new StateGraph();
        expect(() => graph.addNode(new CallbackGraphNode('', async () => {}))).toThrow('non-empty');
    });

    it('StateGraph rejects whitespace-only node ID', () => {
        const graph = new StateGraph();
        expect(() => graph.addNode(new CallbackGraphNode('  ', async () => {}))).toThrow('non-empty');
    });

    it('StateGraph rejects edge from non-existent node', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        expect(() => graph.addEdge('missing', 'a')).toThrow("'missing' does not exist");
    });

    it('StateGraph rejects conditional edge with non-function router', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        expect(() => graph.addConditionalEdge('a', 'not-a-function' as any)).toThrow('function');
    });

    it('CallbackGraphNode rejects empty id', () => {
        expect(() => new CallbackGraphNode('', async () => {})).toThrow('non-empty');
    });

    it('CallbackGraphNode rejects non-function callback', () => {
        expect(() => new CallbackGraphNode('x', 'not-fn' as any)).toThrow('function');
    });

    it('LlmGraphNode rejects missing provider', () => {
        expect(() => new LlmGraphNode({
            id: 'x',
            provider: null as any,
            prompt: () => ({ instructions: '', text: '' }),
            outputKey: 'out',
        })).toThrow('provider');
    });

    it('LlmGraphNode rejects empty outputKey', () => {
        expect(() => new LlmGraphNode({
            id: 'x',
            provider: fakeLLM,
            prompt: () => ({ instructions: '', text: '' }),
            outputKey: '' as any,
        })).toThrow('outputKey');
    });

    it('SubGraphNode rejects missing engine', () => {
        expect(() => new SubGraphNode({
            id: 'x',
            engine: null as any,
            input: () => ({}),
            output: () => {},
        })).toThrow('engine');
    });

    it('SubGraphNode rejects missing input function', () => {
        const dummyEngine = new StateGraphBuilder()
            .addNode(new CallbackGraphNode('a', async () => {}))
            .setEntry('a')
            .build();
        expect(() => new SubGraphNode({
            id: 'x',
            engine: dummyEngine,
            input: null as any,
            output: () => {},
        })).toThrow('input');
    });
});

// ── Hardening: Graph Validation ────────────────────────────────

describe('Graph Validation', () => {
    it('validate() returns error when no entry is set', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        const errors = graph.validate();
        expect(errors.some(e => e.includes('entry'))).toBe(true);
    });

    it('validate() returns empty array for valid graph', () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async () => {}));
        graph.addEdge('a', 'b');
        graph.setEntry('a');
        expect(graph.validate()).toEqual([]);
    });

    it('validate() warns about unreachable nodes', () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('orphan', async () => {}));
        graph.setEntry('a');
        const errors = graph.validate();
        expect(errors.some(e => e.includes("'orphan'") && e.includes('unreachable'))).toBe(true);
    });
});

// ── Hardening: Engine Guards ───────────────────────────────────

describe('Engine Guards', () => {
    it('rejects maxSteps < 1', () => {
        const graph = new StateGraph();
        graph.addNode(new CallbackGraphNode('a', async () => {}));
        graph.setEntry('a');
        expect(() => new StateGraphEngine(graph, { maxSteps: 0 })).toThrow('maxSteps must be');
    });

    it('context is frozen (readonly)', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('check', async (_state, ctx) => {
            expect(() => { (ctx as any).nodeId = 'hacked'; }).toThrow();
        }));
        graph.setEntry('check');
        const engine = new StateGraphEngine(graph);
        await engine.run({ count: 0, log: [] });
    });

    it('error message includes node ID on maxSteps', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('loop', async (s) => { s.count++; }));
        graph.addEdge('loop', 'loop');
        graph.setEntry('loop');

        const engine = new StateGraphEngine(graph, { maxSteps: 3 });
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow("node 'loop'");
    });

    it('throws when conditional edge returns invalid node ID', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async () => {}));
        graph.addConditionalEdge('a', () => 'nonexistent');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow("'nonexistent' not found");
    });
});

// ── Hardening: Builder Guards ──────────────────────────────────

describe('Builder Guards', () => {
    it('builder rejects mutations after build()', () => {
        const builder = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async () => {}))
            .setEntry('a');
        builder.build();
        expect(() => builder.addNode(new CallbackGraphNode<CounterState>('b', async () => {}))).toThrow('already been built');
    });

    it('builder validates on build() and throws on missing entry', () => {
        const builder = new StateGraphBuilder()
            .addNode(new CallbackGraphNode('a', async () => {}));
        expect(() => builder.build()).toThrow('validation failed');
    });

    it('builder validates on build() and warns about unreachable nodes', () => {
        const builder = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async () => {}))
            .addNode(new CallbackGraphNode<CounterState>('orphan', async () => {}))
            .setEntry('a');
        expect(() => builder.build()).toThrow('unreachable');
    });
});

// ── step() API ─────────────────────────────────────────────────

describe('step() — single node execution', () => {
    it('executes one node and returns cursor to next', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; }));
        graph.addEdge('a', 'b');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        const result = await engine.step(state, 'a', 0);

        expect(result.executedNodeId).toBe('a');
        expect(result.nextNodeId).toBe('b');
        expect(result.done).toBe(false);
        expect(state.count).toBe(1); // mutated in place
    });

    it('returns done:true when next is END', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('last', async (s) => { s.count = 42; }));
        graph.addEdge('last', END);
        graph.setEntry('last');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        const result = await engine.step(state, 'last', 0);

        expect(result.done).toBe(true);
        expect(result.nextNodeId).toBe(END);
        expect(state.count).toBe(42);
    });

    it('returns done:true on implicit END (no outbound edge)', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('only', async (s) => { s.count = 7; }));
        graph.setEntry('only');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        const result = await engine.step(state, 'only', 0);

        expect(result.done).toBe(true);
    });

    it('mutates state in place (no clone)', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('mutate', async (s) => { s.count = 999; }));
        graph.setEntry('mutate');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        await engine.step(state, 'mutate');

        expect(state.count).toBe(999); // same object mutated
    });

    it('caller can loop step() to completion', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.log.push('a'); }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.log.push('b'); }));
        graph.addNode(new CallbackGraphNode<CounterState>('c', async (s) => { s.log.push('c'); }));
        graph.addEdge('a', 'b');
        graph.addEdge('b', 'c');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        let nodeId: string = 'a';
        let steps = 0;

        while (true) {
            const result = await engine.step(state, nodeId, steps);
            steps++;
            if (result.done) break;
            nodeId = result.nextNodeId as string;
        }

        expect(state.log).toEqual(['a', 'b', 'c']);
        expect(steps).toBe(3);
    });

    it('follows conditional edges', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('gate', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('high', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('low', async () => {}));
        graph.addConditionalEdge('gate', (s) => s.count > 5 ? 'high' : 'low');
        graph.setEntry('gate');

        const engine = new StateGraphEngine(graph);

        const r1 = await engine.step({ count: 10, log: [] }, 'gate');
        expect(r1.nextNodeId).toBe('high');

        const r2 = await engine.step({ count: 1, log: [] }, 'gate');
        expect(r2.nextNodeId).toBe('low');
    });

    it('enforces maxSteps', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('loop', async (s) => { s.count++; }));
        graph.addEdge('loop', 'loop');
        graph.setEntry('loop');

        const engine = new StateGraphEngine(graph, { maxSteps: 3 });
        await expect(engine.step({ count: 0, log: [] }, 'loop', 3)).rejects.toThrow('Max steps (3) exceeded');
    });

    it('adds node errors to DLQ', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('fail', async () => { throw new Error('step-boom'); }));
        graph.setEntry('fail');

        const engine = new StateGraphEngine(graph);
        await expect(engine.step({ count: 0, log: [] }, 'fail')).rejects.toThrow('step-boom');
        expect(engine.deadLetterQueue).toHaveLength(1);
        expect(engine.deadLetterQueue[0].nodeId).toBe('fail');
    });

    it('snapshot contains deep-cloned post-execution state', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('inc', async (s) => { s.count = 42; }));
        graph.setEntry('inc');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        const result = await engine.step(state, 'inc');

        expect(result.snapshot.state.count).toBe(42);
        // Snapshot is a clone, not same reference
        state.count = 999;
        expect(result.snapshot.state.count).toBe(42);
    });

    it('run() produces same result as manual step() loop', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; s.log.push('a'); }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; s.log.push('b'); }));
        graph.addEdge('a', 'b');
        graph.setEntry('a');

        // run()
        const engine1 = new StateGraphEngine(graph);
        const runResult = await engine1.run({ count: 0, log: [] });

        // step() loop
        const engine2 = new StateGraphEngine(graph);
        const state: CounterState = { count: 0, log: [] };
        let nodeId: string = 'a';
        let steps = 0;
        while (true) {
            const r = await engine2.step(state, nodeId, steps);
            steps++;
            if (r.done) break;
            nodeId = r.nextNodeId as string;
        }

        expect(state.count).toBe(runResult.state.count);
        expect(state.log).toEqual(runResult.state.log);
        expect(steps).toBe(runResult.steps);
    });

    it('stepCount defaults to 0', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('check', async (_s, ctx) => {
            expect(ctx.stepCount).toBe(0);
        }));
        graph.setEntry('check');

        const engine = new StateGraphEngine(graph);
        await engine.step({ count: 0, log: [] }, 'check');
    });
});

// ── Execution Hooks ────────────────────────────────────────────

describe('Execution Hooks', () => {
    it('onBeforeNode fires before node executes', async () => {
        const log: string[] = [];
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async (s) => {
                log.push(`exec:${s.count}`);
                s.count++;
            }))
            .setEntry('a')
            .build({
                onBeforeNode: (nodeId, state, step) => {
                    log.push(`before:${nodeId}:${(state as CounterState).count}:${step}`);
                },
            });

        await engine.run({ count: 0, log: [] });
        expect(log).toEqual(['before:a:0:0', 'exec:0']);
    });

    it('onAfterNode fires after node executes', async () => {
        const log: string[] = [];
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async (s) => {
                s.count = 42;
                log.push('exec');
            }))
            .setEntry('a')
            .build({
                onAfterNode: (nodeId, state, step) => {
                    log.push(`after:${nodeId}:${(state as CounterState).count}:${step}`);
                },
            });

        await engine.run({ count: 0, log: [] });
        expect(log).toEqual(['exec', 'after:a:42:0']);
    });

    it('hooks fire on every node in a chain', async () => {
        const hookLog: string[] = [];
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }))
            .addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; }))
            .setEntry('a')
            .addEdge('a', 'b')
            .build({
                onBeforeNode: (id) => { hookLog.push(`before:${id}`); },
                onAfterNode: (id) => { hookLog.push(`after:${id}`); },
            });

        await engine.run({ count: 0, log: [] });
        expect(hookLog).toEqual(['before:a', 'after:a', 'before:b', 'after:b']);
    });

    it('hooks work with step() too', async () => {
        const hookLog: string[] = [];
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('x', async (s) => { s.count++; }));
        graph.setEntry('x');

        const engine = new StateGraphEngine(graph, {
            onBeforeNode: (id) => { hookLog.push(`before:${id}`); },
            onAfterNode: (id) => { hookLog.push(`after:${id}`); },
        });

        await engine.step({ count: 0, log: [] }, 'x');
        expect(hookLog).toEqual(['before:x', 'after:x']);
    });

    it('async hooks are awaited', async () => {
        const log: string[] = [];
        const engine = new StateGraphBuilder<CounterState>()
            .addNode(new CallbackGraphNode<CounterState>('a', async () => { log.push('exec'); }))
            .setEntry('a')
            .build({
                onBeforeNode: async () => {
                    await new Promise(r => setTimeout(r, 10));
                    log.push('async-before');
                },
                onAfterNode: async () => {
                    await new Promise(r => setTimeout(r, 10));
                    log.push('async-after');
                },
            });

        await engine.run({ count: 0, log: [] });
        expect(log).toEqual(['async-before', 'exec', 'async-after']);
    });
});
// ── Node Retry Policy ─────────────────────────────────────────

describe('Node Retry Policy', () => {
    it('succeeds on first attempt without retrying', async () => {
        let calls = 0;
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('work', async (s) => {
            calls++;
            s.count = 1;
        }));
        graph.setEntry('work');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(1);
        expect(calls).toBe(1);
    });

    it('retries on failure and succeeds within maxRetries', async () => {
        let attempts = 0;
        const flakyNode = new CallbackGraphNode<CounterState>('flaky', async (s) => {
            attempts++;
            if (attempts < 3) throw new Error('transient');
            s.count = 99;
        });
        (flakyNode as any).retryPolicy = { maxRetries: 3, initialDelayMs: 1 };

        const graph = new StateGraph<CounterState>();
        graph.addNode(flakyNode);
        graph.setEntry('flaky');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(99);
        expect(attempts).toBe(3);
    });

    it('exhausts retries and routes to DLQ', async () => {
        const alwaysFails = new CallbackGraphNode<CounterState>('boom', async () => {
            throw new Error('permanent');
        });
        (alwaysFails as any).retryPolicy = { maxRetries: 2, initialDelayMs: 1 };

        const graph = new StateGraph<CounterState>();
        graph.addNode(alwaysFails);
        graph.setEntry('boom');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('permanent');
        expect(engine.deadLetterQueue).toHaveLength(1);
        expect(engine.deadLetterQueue[0].nodeId).toBe('boom');
    });

    it('restores state from pre-snapshot between retries', async () => {
        let attempts = 0;
        const node = new CallbackGraphNode<CounterState>('partial', async (s) => {
            attempts++;
            s.count += 10; // partial mutation
            if (attempts < 2) throw new Error('retry me');
        });
        (node as any).retryPolicy = { maxRetries: 2, initialDelayMs: 1 };

        const graph = new StateGraph<CounterState>();
        graph.addNode(node);
        graph.setEntry('partial');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        // Retry restored count=0 before second attempt, so final count is 10 (not 20)
        expect(result.state.count).toBe(10);
        expect(attempts).toBe(2);
    });

    it('only retries on listed error names when retryOn is specified', async () => {
        let attempts = 0;
        const node = new CallbackGraphNode<CounterState>('typed', async () => {
            attempts++;
            const err = new TypeError('type mismatch');
            throw err;
        });
        (node as any).retryPolicy = {
            maxRetries: 3,
            initialDelayMs: 1,
            retryOn: ['NetworkError'], // TypeError not in list
        };

        const graph = new StateGraph<CounterState>();
        graph.addNode(node);
        graph.setEntry('typed');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('type mismatch');
        // Should not retry — TypeError not in retryOn list
        expect(attempts).toBe(1);
    });

    it('does retry on listed error name', async () => {
        let attempts = 0;
        const node = new CallbackGraphNode<CounterState>('typed', async (s) => {
            attempts++;
            if (attempts < 2) {
                const err = new Error('retry me');
                err.name = 'NetworkError';
                throw err;
            }
            s.count = 5;
        });
        (node as any).retryPolicy = {
            maxRetries: 2,
            initialDelayMs: 1,
            retryOn: ['NetworkError'],
        };

        const graph = new StateGraph<CounterState>();
        graph.addNode(node);
        graph.setEntry('typed');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(5);
        expect(attempts).toBe(2);
    });
});

// ── Node Timeout ──────────────────────────────────────────────

describe('Node Timeout', () => {
    it('aborts a slow node and routes to DLQ', async () => {
        const slow = new CallbackGraphNode<CounterState>('slow', async () => {
            await new Promise(r => setTimeout(r, 500));
        });
        (slow as any).timeoutMs = 20;

        const graph = new StateGraph<CounterState>();
        graph.addNode(slow);
        graph.setEntry('slow');

        const engine = new StateGraphEngine(graph);
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow("timed out after 20ms");
        expect(engine.deadLetterQueue).toHaveLength(1);
    });

    it('does not timeout a fast node', async () => {
        const fast = new CallbackGraphNode<CounterState>('fast', async (s) => {
            s.count = 7;
        });
        (fast as any).timeoutMs = 200;

        const graph = new StateGraph<CounterState>();
        graph.addNode(fast);
        graph.setEntry('fast');

        const engine = new StateGraphEngine(graph);
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(7);
    });
});

// ── Parallel Node Execution ───────────────────────────────────

describe('Parallel Node Execution', () => {
    interface ParallelState extends Record<string, unknown> {
        a: number;
        b: number;
        c: number;
        merged: number;
    }

    it('fans out to multiple nodes concurrently and merges', async () => {
        const engine = new StateGraphBuilder<ParallelState>()
            .addNode(new CallbackGraphNode<ParallelState>('start', async () => {}))
            .addNode(new CallbackGraphNode<ParallelState>('branchA', async (s) => { s.a = 1; }))
            .addNode(new CallbackGraphNode<ParallelState>('branchB', async (s) => { s.b = 2; }))
            .addNode(new CallbackGraphNode<ParallelState>('branchC', async (s) => { s.c = 3; }))
            .addNode(new CallbackGraphNode<ParallelState>('finish', async (s) => { s.merged = s.a + s.b + s.c; }))
            .setEntry('start')
            .addParallelEdge(
                'start',
                ['branchA', 'branchB', 'branchC'],
                (states) => ({
                    ...states[0],
                    a: states[0].a,
                    b: states[1].b,
                    c: states[2].c,
                    merged: 0,
                }),
                'finish',
            )
            .addEdge('finish', END)
            .build();

        const result = await engine.run({ a: 0, b: 0, c: 0, merged: 0 });
        expect(result.state.a).toBe(1);
        expect(result.state.b).toBe(2);
        expect(result.state.c).toBe(3);
        expect(result.state.merged).toBe(6);
    });

    it('parallel branches each receive independent state clone', async () => {
        const seen: number[] = [];
        const engine = new StateGraphBuilder<ParallelState>()
            .addNode(new CallbackGraphNode<ParallelState>('setup', async (s) => { s.a = 42; }))
            .addNode(new CallbackGraphNode<ParallelState>('p1', async (s) => { seen.push(s.a); s.b = 10; }))
            .addNode(new CallbackGraphNode<ParallelState>('p2', async (s) => { seen.push(s.a); s.c = 20; }))
            .setEntry('setup')
            .addParallelEdge('setup', ['p1', 'p2'], (states) => ({ ...states[0], c: states[1].c, merged: 0 }), END)
            .build();

        await engine.run({ a: 0, b: 0, c: 0, merged: 0 });
        // Both branches should see a=42 from setup, not each other's mutations
        expect(seen).toEqual([42, 42]);
    });

    it('parallel branch to END stops graph', async () => {
        const engine = new StateGraphBuilder<ParallelState>()
            .addNode(new CallbackGraphNode<ParallelState>('start', async () => {}))
            .addNode(new CallbackGraphNode<ParallelState>('p1', async (s) => { s.a = 1; }))
            .addNode(new CallbackGraphNode<ParallelState>('p2', async (s) => { s.b = 2; }))
            .setEntry('start')
            .addParallelEdge('start', ['p1', 'p2'], (states) => ({ ...states[0], b: states[1].b, c: 0, merged: 0 }), END)
            .build();

        const result = await engine.run({ a: 0, b: 0, c: 0, merged: 0 });
        expect(result.state.a).toBe(1);
        expect(result.state.b).toBe(2);
        // Only start + parallel (counts as one step)
        expect(result.steps).toBe(1);
    });

    it('addParallelEdge rejects fewer than 2 targets', () => {
        const b = new StateGraphBuilder<ParallelState>()
            .addNode(new CallbackGraphNode<ParallelState>('a', async () => {}))
            .addNode(new CallbackGraphNode<ParallelState>('b', async () => {}));
        expect(() => (b as any).graph?.addParallelEdge('a', ['b'], () => ({} as any), END))
            .toThrow();
    });
});

// ── Checkpoint & Resume ───────────────────────────────────────

describe('Checkpoint & Resume', () => {
    it('checkpoint captures current state and node', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; }));
        graph.addEdge('a', 'b');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 5, log: [] };
        const cp = engine.checkpoint(state, 'b', 1);

        expect(cp.currentNodeId).toBe('b');
        expect(cp.stepCount).toBe(1);
        expect((cp.state as CounterState).count).toBe(5);
        expect(cp.checkpointId).toBeTruthy();
        expect(cp.correlationId).toBeTruthy();
        expect(cp.timestamp).toBeGreaterThan(0);
    });

    it('checkpoint clones state (does not share reference)', () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async () => {}));
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const state: CounterState = { count: 1, log: [] };
        const cp = engine.checkpoint(state, 'a', 0);

        state.count = 999;
        expect((cp.state as CounterState).count).toBe(1); // clone, not same ref
    });

    it('resume continues execution from checkpoint node', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; s.log.push('a'); }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; s.log.push('b'); }));
        graph.addNode(new CallbackGraphNode<CounterState>('c', async (s) => { s.count++; s.log.push('c'); }));
        graph.addEdge('a', 'b');
        graph.addEdge('b', 'c');
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);

        // Run up to 'b' manually, then checkpoint
        const runState: CounterState = { count: 0, log: [] };
        await engine.step(runState, 'a', 0); // executes 'a', count=1
        const cp = engine.checkpoint(runState, 'b', 1);

        // Resume from checkpoint — should run 'b' and 'c'
        const result = await engine.resume(cp);
        expect(result.state.count).toBe(3);
        expect((result.state as CounterState).log).toEqual(['a', 'b', 'c']);
    });

    it('resume clones checkpoint state (does not mutate checkpoint)', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('work', async (s) => { s.count = 99; }));
        graph.setEntry('work');

        const engine = new StateGraphEngine(graph);
        const cp = engine.checkpoint({ count: 0, log: [] }, 'work', 0);
        await engine.resume(cp);

        // Original checkpoint state should be unchanged
        expect((cp.state as CounterState).count).toBe(0);
    });

    it('resume throws when checkpoint node does not exist', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async () => {}));
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph);
        const cp = engine.checkpoint({ count: 0, log: [] }, 'missing-node', 0);
        await expect(engine.resume(cp)).rejects.toThrow("'missing-node' not found");
    });
});

// ── Graph Run Limits ──────────────────────────────────────────

describe('Graph Run Limits', () => {
    it('maxTotalMs throws when wall-clock exceeded', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('slow', async (s) => {
            await new Promise(r => setTimeout(r, 50));
            s.count++;
        }));
        graph.addEdge('slow', 'slow');
        graph.setEntry('slow');

        const engine = new StateGraphEngine(graph, { limits: { maxTotalMs: 30 } });
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('maxTotalMs');
    });

    it('maxTotalMs is not triggered on a fast run', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('fast', async (s) => { s.count = 1; }));
        graph.setEntry('fast');

        const engine = new StateGraphEngine(graph, { limits: { maxTotalMs: 5000 } });
        const result = await engine.run({ count: 0, log: [] });
        expect(result.state.count).toBe(1);
    });

    it('maxToolCalls is enforced at runtime via reportToolCall()', async () => {
        const graph = new StateGraph<CounterState>();
        // Node reports one tool call each time it runs.
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (_s, ctx) => {
            ctx.reportToolCall();
        }));
        graph.addEdge('a', 'a'); // infinite loop
        graph.setEntry('a');
        // maxToolCalls: 2 — third call should throw.
        const engine = new StateGraphEngine(graph, { limits: { maxToolCalls: 2 } });
        await expect(engine.run({ count: 0, log: [] }))
            .rejects.toThrow('maxToolCalls');
    });

    it('maxTotalTokens is enforced at runtime via reportTokens()', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (_s, ctx) => {
            ctx.reportTokens(600);
        }));
        graph.addEdge('a', 'a'); // infinite loop
        graph.setEntry('a');
        const engine = new StateGraphEngine(graph, { limits: { maxTotalTokens: 1000 } });
        await expect(engine.run({ count: 0, log: [] }))
            .rejects.toThrow('maxTotalTokens');
    });
});

// ── Correlation ID ────────────────────────────────────────────

describe('Correlation ID', () => {
    it('propagates configured correlationId to node context', async () => {
        let seenId: string | undefined;
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('check', async (_s, ctx) => {
            seenId = ctx.correlationId;
        }));
        graph.setEntry('check');

        const engine = new StateGraphEngine(graph, { correlationId: 'my-run-id' });
        await engine.run({ count: 0, log: [] });
        expect(seenId).toBe('my-run-id');
    });

    it('uses a random UUID when correlationId is not configured', async () => {
        let seenId: string | undefined;
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('check', async (_s, ctx) => {
            seenId = ctx.correlationId;
        }));
        graph.setEntry('check');

        const engine = new StateGraphEngine(graph);
        await engine.run({ count: 0, log: [] });
        expect(seenId).toBeTruthy();
        expect(seenId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('all trace events carry the correlationId', async () => {
        const tracer = new InMemoryTracer(50);
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'trace-test' });
        await engine.run({ count: 0, log: [] });
        const events = tracer.recent('trace-test', 10);
        expect(events.length).toBeGreaterThan(0);
        expect(events.every(e => e.correlationId === 'trace-test')).toBe(true);
    });
});

// ── ISpanTracer Integration ───────────────────────────────────

describe('ISpanTracer Integration', () => {
    it('emits a root span wrapping the entire run', async () => {
        const tracer = new InMemorySpanTracer();
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.setEntry('a');

        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'span-run' });
        await engine.run({ count: 0, log: [] });

        const spans = tracer.spans('span-run');
        const rootSpan = spans.find(s => s.type === 'graph-run');
        expect(rootSpan).toBeDefined();
        expect(rootSpan!.status).toBe('ok');
        expect(rootSpan!.endTime).toBeGreaterThan(0);
    });

    it('emits a child span for each node execution', async () => {
        const tracer = new InMemorySpanTracer();
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('step1', async (s) => { s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('step2', async (s) => { s.count++; }));
        graph.addEdge('step1', 'step2');
        graph.setEntry('step1');

        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'span-nodes' });
        await engine.run({ count: 0, log: [] });

        const spans = tracer.spans('span-nodes');
        const nodeSpans = spans.filter(s => s.type.startsWith('node.'));
        expect(nodeSpans.map(s => s.type)).toEqual(['node.step1', 'node.step2']);
        expect(nodeSpans.every(s => s.status === 'ok')).toBe(true);
        // Node spans are children of the root span.
        const rootSpan = spans.find(s => s.type === 'graph-run')!;
        expect(nodeSpans.every(s => s.parentSpanId === rootSpan.spanId)).toBe(true);
    });

    it('closes root span with error status when a node throws', async () => {
        const tracer = new InMemorySpanTracer();
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('boom', async () => {
            throw new Error('kaboom');
        }));
        graph.setEntry('boom');

        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'span-err' });
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('kaboom');

        const spans = tracer.spans('span-err');
        const rootSpan = spans.find(s => s.type === 'graph-run');
        const nodeSpan = spans.find(s => s.type === 'node.boom');
        expect(nodeSpan!.status).toBe('error');
        expect(nodeSpan!.error).toBe('kaboom');
        expect(rootSpan!.status).toBe('error');
    });

    it('falls back to flat trace events when tracer is not an ISpanTracer', async () => {
        const tracer = new InMemoryTracer(50);
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.setEntry('a');

        // Should not throw — the engine gracefully degrades.
        const engine = new StateGraphEngine(graph, { tracer, correlationId: 'flat-trace' });
        await engine.run({ count: 0, log: [] });
        const events = tracer.recent('flat-trace', 10);
        expect(events.some(e => e.type === 'graph.step')).toBe(true);
    });
});

// ── GraphContext reportToolCall / reportTokens ─────────────────

describe('GraphContext — reportToolCall / reportTokens', () => {
    it('reportToolCall() is available on context and counted towards maxToolCalls', async () => {
        let ctxCapture: GraphContext<CounterState> | undefined;
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (_s, ctx) => {
            ctxCapture = ctx;
            ctx.reportToolCall(3);
        }));
        graph.setEntry('a');
        // 4 allowed — reporting 3 should not throw.
        const engine = new StateGraphEngine(graph, { limits: { maxToolCalls: 4 } });
        await engine.run({ count: 0, log: [] });
        expect(ctxCapture).toBeDefined();
        expect(typeof ctxCapture!.reportToolCall).toBe('function');
    });

    it('reportTokens() is available on context and counted towards maxTotalTokens', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (_s, ctx) => {
            ctx.reportTokens(999);
        }));
        graph.addEdge('a', 'a');
        graph.setEntry('a');
        // 1000 limit — second pass (2×1998 cumulative, but checked pre-step) should fail.
        const engine = new StateGraphEngine(graph, { limits: { maxTotalTokens: 1000 } });
        await expect(engine.run({ count: 0, log: [] })).rejects.toThrow('maxTotalTokens');
    });
});

// ── resume() fresh step budget ────────────────────────────────

describe('resume() fresh step budget', () => {
    it('resumed run gets a full maxSteps budget regardless of checkpoint stepCount', async () => {
        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('a', async (s) => { s.count++; }));
        graph.addNode(new CallbackGraphNode<CounterState>('b', async (s) => { s.count++; }));
        graph.addEdge('a', 'b');
        graph.setEntry('a');

        // Engine with maxSteps: 2
        const engine = new StateGraphEngine(graph, { maxSteps: 2 });

        // Checkpoint at stepCount: 99 (close to a hypothetical limit).
        // The old behaviour would have let resume() start at step 99, leaving
        // only 1 step — not enough to finish a→b. With the fix, it starts at 0.
        const cp = engine.checkpoint({ count: 0, log: [] }, 'a', 99);
        const result = await engine.resume(cp);
        expect(result.state.count).toBe(2); // both nodes ran
        expect(result.steps).toBe(2);
    });
});

// ── Parallel branches fire hooks ──────────────────────────────

describe('Parallel branch hooks', () => {
    it('onBeforeNode and onAfterNode fire for each parallel branch', async () => {
        const beforeCalls: string[] = [];
        const afterCalls: string[] = [];

        const graph = new StateGraph<CounterState>();
        graph.addNode(new CallbackGraphNode<CounterState>('fan', async () => {}));
        graph.addNode(new CallbackGraphNode<CounterState>('brA', async (s) => { s.count += 1; }));
        graph.addNode(new CallbackGraphNode<CounterState>('brB', async (s) => { s.count += 10; }));
        graph.addParallelEdge(
            'fan',
            ['brA', 'brB'],
            (states) => ({ count: states.reduce((sum, s) => sum + s.count, 0), log: [] }),
            END,
        );
        graph.setEntry('fan');

        const engine = new StateGraphEngine(graph, {
            onBeforeNode: (id) => { beforeCalls.push(id); },
            onAfterNode:  (id) => { afterCalls.push(id); },
        });
        await engine.run({ count: 0, log: [] });

        // fan is the sequential node, brA/brB are parallel branches.
        expect(beforeCalls).toContain('fan');
        expect(beforeCalls).toContain('brA');
        expect(beforeCalls).toContain('brB');
        expect(afterCalls).toContain('brA');
        expect(afterCalls).toContain('brB');
    });
});