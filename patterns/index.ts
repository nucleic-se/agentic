/**
 * Agentic Design Patterns
 *
 * Pre-built graph patterns for common agent workflows. Each pattern
 * is a factory function that returns a configured IGraphEngine.
 *
 * Patterns are composable — use SubGraphNode to nest them arbitrarily.
 *
 * @module patterns
 */

// Base types
export type {
    PatternConfig,
    PatternFactory,
    ToolFunction,
    ToolRegistry,
    RetrieverFunction,
    HumanInputFunction,
} from './types.js';

// ReAct Pattern
export { createReActAgent } from './react.js';
export type { ReActState, ReActConfig } from './react.js';

// Plan-Execute Pattern
export { createPlanExecuteAgent } from './plan-execute.js';
export type { PlanExecuteState, PlanExecuteConfig } from './plan-execute.js';

// Reflection Pattern
export { createReflectionAgent } from './reflection.js';
export type { ReflectionState, ReflectionConfig } from './reflection.js';

// RAG Pattern
export { createRAGAgent } from './rag.js';
export type { RAGState, RAGConfig } from './rag.js';

// Chain-of-Thought Pattern
export { createChainOfThoughtAgent } from './chain-of-thought.js';
export type { ChainOfThoughtState, ChainOfThoughtConfig } from './chain-of-thought.js';

// Supervisor-Worker Pattern
export { createSupervisorAgent } from './supervisor-worker.js';
export type {
    SupervisorState,
    SupervisorWorkerConfig,
    WorkerAgent,
} from './supervisor-worker.js';

// Human-in-the-Loop Pattern
export { createHumanInLoopAgent } from './human-in-loop.js';
export type { HumanInLoopState, HumanInLoopConfig } from './human-in-loop.js';
