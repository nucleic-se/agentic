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
} from './contracts/index.js';

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
} from './runtime/index.js';

export type { MigrationState } from './runtime/index.js';

// ── Utilities ──────────────────────────────────────────────────
export { estimateTokens } from './utils.js';
