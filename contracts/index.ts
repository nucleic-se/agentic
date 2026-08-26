/**
 * @nucleic/agentic contracts barrel.
 *
 * Re-exports all domain-agnostic contracts from one place.
 */

// Prompt composition
export type {
    PromptSection,
    PromptSectionTag,
    PromptSectionPhase,
    PromptComposeResult,
    PromptComposeOptions,
    IPromptEngine,
    PromptContributionContext,
    IPromptContributor,
    IPromptContributorRegistry,
} from './IPromptEngine.js';

// Tick pipeline
export type {
    TickContext,
    ITickStep,
    ITickPipeline,
} from './ITickPipeline.js';

// Observability
export type {
    TraceEvent,
    ITracer,
    TraceSpan,
    ISpanTracer,
} from './IObservability.js';

// Pack manifest
export type {
    IPackManifest,
    IPackMigration,
    PackCommandDef,
} from './IPackManifest.js';

// Pack bootstrap
export type {
    IPackBootstrap,
    PackBootstrapContext,
} from './IPackBootstrap.js';

// Pack registry
export type {
    IPackRegistry,
    PackValidationError,
} from './IPackRegistry.js';

// Capability contracts (Wave 2)
export type {
    ICapability,
    ICapabilityLifecycle,
} from './ICapability.js';

// Shared types
export type { JsonSchema } from './shared.js';

// Typed tool system
export type {
    ToolTrustTier,
    ValidationIssue,
    ValidationResult,
    RuntimeSchema,
    ToolExecutionContext,
    ITool,
    ToolResult,
    IToolRegistry,
} from './ITool.js';

// Memory system
export type {
    MemoryType,
    MemoryItem,
    MemoryQuery,
    IMemoryStore,
    IMemoryWriteValidator,
    MemorySlot,
    MemoryFact,
    IFactStore,
} from './IMemory.js';

// Tool prompt rendering
export type { IToolPromptRenderer } from './IToolPromptRenderer.js';

// Context assembly (section-level)
export type { AssemblyInput, IContextAssembler } from './IContextAssembler.js';

// Agent context assembly (turn-level: produces system + messages for TurnRequest)
export type {
    AgentContextInput,
    AgentContextOutput,
    IAgentContextAssembler,
} from './IAgentContextAssembler.js';

// LLM provider v2 — message threading, tool calls, token usage
export type {
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
    ProviderCallOptions,
} from './llm.js';

// Tool runtime
export type {
    IToolRuntime,
    IValidatedToolRuntime,
    ToolCallResult,
    ToolCallOptions,
    ToolCallValidation,
} from './tool-runtime.js';

// Tool policy
export type {
    PolicyContext,
    PolicyDecision,
    IToolPolicy,
} from './IToolPolicy.js'

// Agent runtime contracts
export type {
    ToolPlan,
    ToolExecutionStatus,
    ToolExecution,
    FailureKind,
    Failure,
    TurnOutcome,
    TurnRecord,
    AgentEvent,
    AgentEventSink,
    ContextSource,
    CandidateLane,
    ContextScore,
    ContextCandidate,
} from './agent.js';

// Token counting
export type { ITokenCounter } from './ITokenCounter.js';

// Fluent AI builders
export type {
    IAIPromptBuilder,
    IAIPromptService,
    IAIPipeline,
    PipelineOptions,
} from './IAIBuilder.js';

// State graph engine
export { END, GraphRunLimitError } from './graph/index.js';
export type {
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
    GraphRunOptions,
    GraphStepResult,
    IGraphEngine,
    IGraphBuilder,
} from './graph/index.js';
