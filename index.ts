/** Public primitives. Provider and harness adapters also have dedicated subpaths. */
export * from './contracts/index.js';
export * from './runtime/index.js';

// ── Patterns ───────────────────────────────────────────────────
export {
    createReActAgent,
    createPlanExecuteAgent,
    createReflectionAgent,
    createRAGAgent,
    createChainOfThoughtAgent,
    createSupervisorAgent,
    createHumanInLoopAgent,
    createRouterAgent,
    createMapReduceAgent,
} from './patterns/index.js';

export type {
    PatternConfig,
    PatternFactory,
    ToolFunction,
    ToolRegistry as ToolMap,
    RetrieverFunction,
    HumanInputFunction,
    ReActState,
    ReActConfig,
    PlanExecuteState,
    PlanExecuteConfig,
    ReflectionState,
    ReflectionConfig,
    RAGState,
    RAGConfig,
    ChainOfThoughtState,
    ChainOfThoughtConfig,
    SupervisorState,
    SupervisorWorkerConfig,
    WorkerAgent,
    HumanInLoopState,
    HumanInLoopConfig,
    RouterState,
    RouterConfig,
    RouterHandler,
    MapReduceState,
    MapReduceConfig,
} from './patterns/index.js';

// ── Tools ──────────────────────────────────────────────────────
export { ToolRuntimeAdapter, CompositeToolRuntime } from './tools/index.js';

// ── Utilities ──────────────────────────────────────────────────
export { estimateTokens } from './utils.js';
