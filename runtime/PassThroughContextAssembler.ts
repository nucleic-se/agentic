/**
 * Pass-through agent context assembler.
 *
 * The minimal IAgentContextAssembler implementation. Passes the full message
 * array through unchanged and returns a static system string. Use this for
 * Phase A agent implementations before a selection-aware broker is introduced.
 *
 * @module runtime
 */

import type {
    IAgentContextAssembler,
    AgentContextInput,
    AgentContextOutput,
} from '../contracts/IAgentContextAssembler.js'

export class PassThroughContextAssembler implements IAgentContextAssembler {
    constructor(private readonly systemPrompt: string = '') {}

    async assemble(input: AgentContextInput): Promise<AgentContextOutput> {
        return {
            system:   this.systemPrompt,
            messages: input.messages,
        }
    }
}
