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
} from './index.js';
import { END } from './contracts/index.js';
import type { IGraphNode, GraphContext, ILLMProvider, LLMRequest } from './index.js';

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
    async process<T>(req: LLMRequest<T>): Promise<T> {
        return `llm:${req.text}` as unknown as T;
    },
    async embed() { return [0.1, 0.2]; },
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

        const engine = new StateGraphEngine(graph, { tracer });
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

        const engine = new StateGraphEngine(graph, { tracer });
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
            .build({ maxSteps: 50, tracer });

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

    it('supports model and temperature overrides', async () => {
        const calls: LLMRequest[] = [];
        const spyLLM: ILLMProvider = {
            async process(req: LLMRequest) {
                calls.push(req);
                return 'result';
            },
            async embed() { return []; },
        };

        const node = new LlmGraphNode<ResearchState>({
            id: 'llm',
            provider: spyLLM,
            prompt: (s) => ({ instructions: 'go', text: s.topic }),
            outputKey: 'plan',
            model: 'gpt-4o',
            temperature: 0.2,
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

        expect(calls[0].model).toBe('gpt-4o');
        expect(calls[0].temperature).toBe(0.2);
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

    it('catches invalid conditional edge return and adds to DLQ', async () => {
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
