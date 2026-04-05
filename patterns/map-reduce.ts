/**
 * Map-Reduce Pattern
 *
 * Splits a task into independent items, processes them in parallel,
 * then reduces the mapped outputs into a final answer.
 *
 * Flow: map(item*) → reduce → END
 *
 * @module patterns/map-reduce
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

export interface MapReduceState extends GraphState {
    input: string;
    items: string[];
    mapped: string[];
    output: string;
}

export interface MapReduceConfig extends PatternConfig<MapReduceState> {
    mapper: (item: string, context: { input: string; index: number }) => Promise<string>;
    reducer: (mapped: string[], context: { input: string; items: string[] }) => Promise<string>;
}

type MapItemState = {
    item: string;
    input: string;
    index: number;
    mapped: string;
};

export function createMapReduceAgent(config: MapReduceConfig): IGraphEngine<MapReduceState> {
    const mapEngine = new StateGraphBuilder<MapItemState>()
        .addNode(new CallbackGraphNode<MapItemState>('map_item', async (state) => {
            state.mapped = await config.mapper(state.item, {
                input: state.input,
                index: state.index,
            });
        }))
        .setEntry('map_item')
        .addEdge('map_item', END)
        .build({
            maxSteps: 2,
            tracer: config.tracer,
        });

    const mapAll = new CallbackGraphNode<MapReduceState>('map_all', async (state) => {
        state.mapped = await Promise.all(
            state.items.map(async (item, index) => {
                const result = await mapEngine.run({
                    item,
                    input: state.input,
                    index,
                    mapped: '',
                });
                return result.state.mapped;
            }),
        );
    });

    const reduce = new CallbackGraphNode<MapReduceState>('reduce', async (state) => {
        state.output = await config.reducer(state.mapped, {
            input: state.input,
            items: state.items,
        });
    });

    return new StateGraphBuilder<MapReduceState>()
        .addNode(mapAll)
        .addNode(reduce)
        .setEntry('map_all')
        .addEdge('map_all', 'reduce')
        .addEdge('reduce', END)
        .build({
            maxSteps: Math.max(4, (config.maxIterations ?? 8)),
            tracer: config.tracer,
        });
}
