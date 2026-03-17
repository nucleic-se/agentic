/**
 * CodingAgent — public API barrel.
 *
 * The two exports here are sufficient for Phase A usage:
 *
 *   import { createCodingAgent, createCodingTools } from './demo/agent/index.js'
 */

export { CodingAgent }                       from './CodingAgent.js'
export { createCodingTools, createCodingRegistry } from './tools.js'
export type { CreateCodingToolsOptions }     from './tools.js'
export { DefaultToolPolicy }                 from './tool-policy.js'
export type { ExternalArtifact }             from './artifact.js'
export type { AgentConfig }                  from './config.js'

import { CodingAgent }                       from './CodingAgent.js'
import type { AgentConfig }                  from './config.js'

/**
 * Convenience factory. Equivalent to `new CodingAgent(config)`.
 * Provides a stable call-site that won't break if the class constructor changes.
 */
export function createCodingAgent(config: AgentConfig): CodingAgent {
  return new CodingAgent(config)
}
