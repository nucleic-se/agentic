/** Narrow public entry point for composing the base agent kernel. */
export { DEFAULT_MAX_TOOL_CALLS_PER_TURN, runAgentKernel } from './runtime/AgentKernel.js';
export type {
    AgentKernelConfig,
    AgentKernelContext,
    BeforeKernelToolCallResult,
} from './runtime/AgentKernel.js';
export { AgentContextAssembler, ContextBudgetExceededError } from './runtime/AgentContextAssembler.js';
export type { ConversationAssemblerConfig } from './runtime/AgentContextAssembler.js';
