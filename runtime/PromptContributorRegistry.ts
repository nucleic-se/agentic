/**
 * In-memory prompt contributor registry.
 */

import type {
    PromptContributionContext,
    IPromptContributor,
    IPromptContributorRegistry,
} from '../contracts/index.js';

export class PromptContributorRegistry<TContext extends PromptContributionContext = PromptContributionContext>
    implements IPromptContributorRegistry<TContext>
{
    private contributors = new Map<string, IPromptContributor<TContext>>();

    register(contributor: IPromptContributor<TContext>): void {
        this.contributors.set(contributor.id, contributor);
    }

    list(): IPromptContributor<TContext>[] {
        return Array.from(this.contributors.values());
    }

    resolve(id: string): IPromptContributor<TContext> | null {
        return this.contributors.get(id) ?? null;
    }
}
