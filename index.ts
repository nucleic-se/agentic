/**
 * @nucleic/agentic — domain-agnostic agentic toolbox.
 *
 * Reusable primitives for prompt composition, tick pipelines,
 * pack/capability management, migration orchestration, and tracing.
 *
 * Contracts are generic with sensible defaults.
 * Domains extend via generic type parameters (e.g. TickContext).
 */

// ── Contracts ──────────────────────────────────────────────────
export type {
    PromptSection,
    PromptSectionTag,
    PromptComposeResult,
    IPromptEngine,
    PromptContributionContext,
    IPromptContributor,
    IPromptContributorRegistry,
    TickContext,
    ITickStep,
    ITickPipeline,
    TraceEvent,
    ITracer,
    IPackManifest,
    IPackMigration,
    PackCommandDef,
    IPackBootstrap,
    PackBootstrapContext,
    ICapabilityRegistry,
    PackValidationError,
    ILLMProvider,
    LLMRequest,
    IAIPromptBuilder,
    IAIPromptService,
    IAIPipeline,
    PipelineOptions,
    GraphState,
    GraphEnd,
    IGraphNode,
    GraphContext,
    RouterFn,
    IGraph,
    GraphSnapshot,
    GraphRunResult,
    GraphDeadLetter,
    GraphEngineConfig,
    GraphStepResult,
    IGraphEngine,
    IGraphBuilder,
} from './contracts/index.js';

export { END } from './contracts/index.js';

// ── Runtimes ───────────────────────────────────────────────────
export {
    PromptEngine,
    PromptContributorRegistry,
    TickPipeline,
    InMemoryTracer,
    CapabilityRegistry,
    MigrationOrchestrator,
    InMemoryMigrationState,
    AIPromptService,
    AIPromptBuilder,
    AIPipeline,
    StateGraph,
    StateGraphEngine,
    StateGraphBuilder,
    CallbackGraphNode,
    LlmGraphNode,
    SubGraphNode,
} from './runtime/index.js';

export type { LlmGraphNodeConfig, SubGraphNodeConfig } from './runtime/index.js';

export type { MigrationState } from './runtime/index.js';

// ── Patterns ───────────────────────────────────────────────────
export {
    createReActAgent,
    createPlanExecuteAgent,
    createReflectionAgent,
    createRAGAgent,
    createChainOfThoughtAgent,
    createSupervisorAgent,
    createHumanInLoopAgent,
} from './patterns/index.js';

export type {
    PatternConfig,
    PatternFactory,
    ToolFunction,
    ToolRegistry,
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
} from './patterns/index.js';

// ── Utilities ──────────────────────────────────────────────────
export { estimateTokens } from './utils.js';
