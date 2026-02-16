/**
 * @nucleic/agentic contracts barrel.
 *
 * Re-exports all domain-agnostic contracts from one place.
 */

// Prompt composition
export type {
    PromptSection,
    PromptSectionTag,
    PromptComposeResult,
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

// Capability registry
export type {
    ICapabilityRegistry,
    PackValidationError,
} from './ICapabilityRegistry.js';

// LLM provider
export type {
    ILLMProvider,
    LLMRequest,
} from './ILLMProvider.js';

// Fluent AI builders
export type {
    IAIPromptBuilder,
    IAIPromptService,
    IAIPipeline,
    PipelineOptions,
} from './IAIBuilder.js';

// State graph engine
export { END } from './graph/index.js';
export type {
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
    IGraphEngine,
    IGraphBuilder,
} from './graph/index.js';
