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
    PromptSectionPhase,
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
    TraceSpan,
    ISpanTracer,
    IPackManifest,
    IPackMigration,
    PackCommandDef,
    IPackBootstrap,
    PackBootstrapContext,
    ICapabilityRegistry,
    PackValidationError,
    JsonSchema,
    ToolTrustTier,
    RetryPolicy,
    RateLimit,
    ITool,
    ToolResult,
    IToolRegistry,
    IToolPolicy,
    PolicyContext,
    PolicyDecision,
    MemoryType,
    MemoryItem,
    MemoryQuery,
    IMemoryStore,
    IMemoryWriteValidator,
    MemorySlot,
    MemoryFact,
    IFactStore,
    IToolPromptRenderer,
    AssemblyInput,
    IContextAssembler,
    ILLMProvider,
    IModelRouter,
    ModelTier,
    Message,
    UserMessage,
    AssistantMessage,
    ToolResultMessage,
    ToolCall,
    ToolDefinition,
    TokenUsage,
    StructuredRequest,
    StructuredResponse,
    TurnRequest,
    TurnResponse,
    StopReason,
    IToolRuntime,
    ToolCallResult,
    IAIPromptBuilder,
    IAIPromptService,
    IAIPipeline,
    PipelineOptions,
    GraphState,
    GraphEnd,
    NodeRetryPolicy,
    IGraphNode,
    GraphContext,
    RouterFn,
    AsyncRouterFn,
    ParallelMergeFn,
    ParallelEdge,
    IGraph,
    GraphSnapshot,
    GraphRunResult,
    GraphCheckpoint,
    GraphDeadLetter,
    GraphRunLimits,
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
    InMemorySpanTracer,
    CapabilityRegistry,
    PackMigrationRunner,
    InMemoryMigrationState,
    ToolRegistry,
    InMemoryStore,
    ToolPromptRenderer,
    ContextAssembler,
    AgentContextAssembler,
    AIPromptService,
    AIPromptBuilder,
    AIPipeline,
    StateGraph,
    StateGraphEngine,
    StateGraphBuilder,
    CallbackGraphNode,
    LlmGraphNode,
    SubGraphNode,
    AgentLlmNode,
} from './runtime/index.js';

export type { LlmGraphNodeConfig, SubGraphNodeConfig, AgentLlmNodeConfig, AgentLlmEvent, OnErrorAction, AgentLlmOnError } from './runtime/index.js';
export type { AgentContextAssemblerConfig } from './runtime/index.js';

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
} from './patterns/index.js';

// ── Utilities ──────────────────────────────────────────────────
export { estimateTokens } from './utils.js';
