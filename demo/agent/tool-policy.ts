/**
 * DefaultToolPolicy — demo-specific default tool policy.
 *
 * Extends TrustTierToolPolicy (library) which:
 *   - Denies calls to tools not registered in IToolRegistry
 *   - Allows all registered tools regardless of trust tier
 *
 * Phase F: 'confirm' decisions pass through to the kernel, which delegates
 * to config.confirmToolCall for real user confirmation. If no hook is
 * configured, the kernel falls back to deny.
 *
 * To add call-budget enforcement, domain restrictions, or require-confirmation
 * gates for untrusted tools: extend this class and override evaluate().
 */

import { TrustTierToolPolicy } from '../../runtime/ToolPolicy.js'

export class DefaultToolPolicy extends TrustTierToolPolicy {}
