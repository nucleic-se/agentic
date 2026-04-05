/**
 * Router Pattern
 *
 * Classifies an input and routes it to one of several handlers.
 *
 * Flow: route → dispatch → END
 *
 * @module patterns/router
 */

import type { GraphState, IGraphEngine } from '../contracts/index.js';
import type { PatternConfig } from './types.js';
import { StateGraphBuilder } from '../runtime/graph/StateGraphBuilder.js';
import { LlmGraphNode } from '../runtime/graph/nodes/LlmGraphNode.js';
import { CallbackGraphNode } from '../runtime/graph/nodes/CallbackGraphNode.js';
import { END } from '../contracts/graph/index.js';

export interface RouterState extends GraphState {
    input: string;
    route: string;
    rationale: string;
    output: string;
}

export interface RouterHandler {
    description: string;
    handle: (input: string, context: { route: string; rationale: string }) => Promise<string>;
}

export interface RouterConfig extends PatternConfig<RouterState> {
    routes: Record<string, RouterHandler>;
    fallbackRoute?: string;
}

export function createRouterAgent(config: RouterConfig): IGraphEngine<RouterState> {
    const routeNames = Object.keys(config.routes);
    const fallbackRoute = config.fallbackRoute ?? routeNames[0] ?? '';

    const router = new LlmGraphNode<RouterState>({
        id: 'route',
        provider: config.llm,
        prompt: (state) => ({
            instructions: `Choose the best route for the input.

Available routes:
${routeNames.map((name) => `- ${name}: ${config.routes[name]!.description}`).join('\n')}

Respond with JSON:
{
  "route": "one of the available route names",
  "rationale": "brief explanation"
}`,
            text: state.input,
            schema: {
                type: 'object',
                properties: {
                    route: { type: 'string' },
                    rationale: { type: 'string' },
                },
                required: ['route', 'rationale'],
                additionalProperties: false,
            },
        }),
        outputKey: 'route',
    });

    const parseRoute = new CallbackGraphNode<RouterState>('parse_route', async (state) => {
        const parsed = typeof state.route === 'string'
            ? JSON.parse(state.route as unknown as string)
            : state.route as unknown as { route?: string; rationale?: string };

        state.route = parsed.route && config.routes[parsed.route] ? parsed.route : fallbackRoute;
        state.rationale = parsed.rationale ?? '';
    });

    const dispatch = new CallbackGraphNode<RouterState>('dispatch', async (state) => {
        const handler = config.routes[state.route];
        if (!handler) {
            state.output = `No handler available for route: ${state.route}`;
            return;
        }
        state.output = await handler.handle(state.input, {
            route: state.route,
            rationale: state.rationale,
        });
    });

    return new StateGraphBuilder<RouterState>()
        .addNode(router)
        .addNode(parseRoute)
        .addNode(dispatch)
        .setEntry('route')
        .addEdge('route', 'parse_route')
        .addEdge('parse_route', 'dispatch')
        .addEdge('dispatch', END)
        .build({
            maxSteps: config.maxIterations ?? 6,
            tracer: config.tracer,
        });
}
