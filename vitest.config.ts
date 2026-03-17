import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: [
            'agentic-core.test.ts',
            'patterns.test.ts',
            'state-graph.test.ts',
            'demo/agent/kernel.test.ts',
            'demo/agent/CodingAgent.test.ts',
        ],
    },
});
