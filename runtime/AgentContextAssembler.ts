import type { IAgentContextAssembler, AgentContextInput, AgentContextOutput } from '../contracts/IAgentContextAssembler.js';
import type { Message } from '../contracts/llm.js';
import type { ITokenCounter } from '../contracts/ITokenCounter.js';
import type { PromptSection } from '../contracts/IPromptEngine.js';
import { composeAgentContext } from './ContextPipeline.js';

export { ContextBudgetExceededError, ContextCompressionError } from './ContextPipeline.js';

export interface ConversationAssemblerConfig {
    systemPrompt: string;
    tokenBudget: number;
    tokenCounter?: ITokenCounter;
    imageTokenEstimate?: number;
    /** Always protect the last N atomic message groups. Default: 2. */
    minRecentGroups?: number;
    scorer?(message: Message, groupIndex: number): number;
    sticky?(message: Message, messageIndex: number): boolean;
    /** Compression can change text but not identity, provenance, tool calls or media. */
    onCompress?(message: Message): Promise<Message | null>;
    onDrop?(message: Message): void;
    compressSection?(section: PromptSection): Promise<string | null> | string | null;
}

/** Compatibility adapter around the stateless contribution/selection/render pipeline. */
export class AgentContextAssembler implements IAgentContextAssembler {
    constructor(private readonly config: ConversationAssemblerConfig) {
        if (!Number.isSafeInteger(config.tokenBudget) || config.tokenBudget <= 0) throw new RangeError('tokenBudget must be a positive safe integer');
        if (config.minRecentGroups !== undefined && (!Number.isSafeInteger(config.minRecentGroups) || config.minRecentGroups < 0)) throw new RangeError('minRecentGroups must be a non-negative safe integer');
        if (config.imageTokenEstimate !== undefined && (!Number.isSafeInteger(config.imageTokenEstimate) || config.imageTokenEstimate < 1)) throw new RangeError('imageTokenEstimate must be a positive safe integer');
    }
    async assemble(input: AgentContextInput): Promise<AgentContextOutput> {
        const result = await composeAgentContext({
            system: input.system ?? this.config.systemPrompt,
            messages: input.messages,
            sections: input.sections,
            tools: input.tools,
            tokenBudget: input.tokenBudget ?? this.config.tokenBudget,
            reservedOutputTokens: input.reservedOutputTokens,
            signal: input.signal,
        }, {
            tokenCounter: this.config.tokenCounter,
            imageTokenEstimate: this.config.imageTokenEstimate,
            minRecentGroups: this.config.minRecentGroups,
            scoreGroup: this.config.scorer ? (messages, index) => this.config.scorer!(messages[0], index) : undefined,
            protectMessage: this.config.sticky,
            compressMessage: this.config.onCompress,
            compressSection: this.config.compressSection,
            onDrop: this.config.onDrop,
        });
        return { system: result.system, messages: result.messages, report: { usage: result.usage, decisions: result.decisions, systemSections: result.systemSections } };
    }
}
