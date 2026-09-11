/** Explicit coding composition. Import /harness/core for the empty host. */
export { codingToolRuntime, codingToolEffect, defaultCodingPolicy } from './coding.js';
export { createDefaultAgent, defaultAgentExtensions } from './preset.js';
export type { DefaultAgentOptions } from './preset.js';
export { agentContext, codingAgentContext } from './agent-context.js';
export type { AgentContextOptions, CodingAgentContextOptions } from './agent-context.js';
export { readProjectInstructions, projectInstructionText, projectInstructionTargets } from './instructions.js';
