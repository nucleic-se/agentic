/**
 * Context assembler runtime.
 *
 * Wraps IPromptEngine and IToolPromptRenderer to provide a single
 * entry point for assembling prompts with tool result rendering
 * and phase-ordered composition.
 *
 * @module runtime
 */

import type { IContextAssembler, AssemblyInput } from '../contracts/IContextAssembler.js';
import type { IPromptEngine, PromptComposeResult, PromptSection } from '../contracts/IPromptEngine.js';
import type { IToolPromptRenderer } from '../contracts/IToolPromptRenderer.js';

/** Collect ordinary sections without selecting them; suitable input to composeAgentContext. */
export function collectContextSections(
    input: Pick<AssemblyInput, 'contributorSections' | 'toolResults'>,
    toolRenderer: IToolPromptRenderer,
): PromptSection[] {
    return [...input.contributorSections, ...(input.toolResults?.length ? toolRenderer.render(input.toolResults) : [])];
}

export class ContextAssembler implements IContextAssembler {
    constructor(
        private readonly engine: IPromptEngine,
        private readonly toolRenderer: IToolPromptRenderer,
    ) {}

    assemble(input: AssemblyInput): PromptComposeResult {
        return this.engine.compose(collectContextSections(input, this.toolRenderer), input.tokenBudget);
    }
}
