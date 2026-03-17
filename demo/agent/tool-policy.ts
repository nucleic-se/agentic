/**
 * DefaultToolPolicy — demo-specific default tool policy.
 *
 * Extends TrustTierToolPolicy (library) which:
 *   - Denies calls to tools not registered in IToolRegistry
 *   - Allows all registered tools regardless of trust tier
 *
 * Phase B addition: 'confirm' decisions are downgraded to 'deny' because
 * the confirmation-gate interaction channel is a Phase F concern. When Phase F
 * is implemented, this class should remove the confirm→deny mapping and let
 * the kernel pause for user input instead.
 *
 * To add call-budget enforcement, domain restrictions, or require-confirmation
 * gates for untrusted tools: extend this class and override evaluate().
 */

import { TrustTierToolPolicy }              from '../../runtime/ToolPolicy.js'
import type { PolicyContext, PolicyDecision } from '../../contracts/IToolPolicy.js'

export class DefaultToolPolicy extends TrustTierToolPolicy {
  async evaluate(ctx: PolicyContext): Promise<PolicyDecision> {
    const decision = await super.evaluate(ctx)

    // Phase B: 'confirm' treated as 'deny' — no interaction channel yet.
    // Phase F will replace this with a real pause-and-await mechanism.
    if (decision.kind === 'confirm') {
      return { kind: 'deny', reason: `Pending confirmation: ${decision.reason}` }
    }

    return decision
  }
}
