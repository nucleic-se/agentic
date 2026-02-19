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
import type { IPromptEngine, PromptComposeResult } from '../contracts/IPromptEngine.js';
import type { IToolPromptRenderer } from '../contracts/IToolPromptRenderer.js';

export class ContextAssembler implements IContextAssembler {
    constructor(
        private readonly engine: IPromptEngine,
        private readonly toolRenderer: IToolPromptRenderer,
    ) {}

    assemble(input: AssemblyInput): PromptComposeResult {
        const sections = [...input.contributorSections];

        // Render tool results into sections with trust-tier labeling
        if (input.toolResults && input.toolResults.length > 0) {
            const toolSections = this.toolRenderer.render(input.toolResults);
            sections.push(...toolSections);
        }

        return this.engine.compose(sections, input.tokenBudget);
    }
}
