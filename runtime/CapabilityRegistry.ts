/**
 * In-memory capability registry with topological dependency validation.
 *
 * Validates pack dependency graphs and resolves boot order.
 * Missing required provider => hard startup error.
 */

import type { ICapabilityRegistry, IPackManifest, PackValidationError } from '../contracts/index.js';

export class CapabilityRegistry implements ICapabilityRegistry {
    private manifests = new Map<string, IPackManifest>();

    registerManifest(manifest: IPackManifest): void {
        this.manifests.set(manifest.id, manifest);
    }

    getManifest(packId: string): IPackManifest | null {
        return this.manifests.get(packId) ?? null;
    }

    listManifests(): IPackManifest[] {
        return Array.from(this.manifests.values());
    }

    validateDependencies(enabledPackIds: string[]): PackValidationError[] {
        const errors: PackValidationError[] = [];
        const enabledSet = new Set(enabledPackIds);

        // Collect all tokens provided by enabled packs
        const providedTokens = new Set<string>();
        for (const packId of enabledPackIds) {
            const manifest = this.manifests.get(packId);
            if (!manifest) {
                errors.push({ packId, message: `Pack "${packId}" is not registered` });
                continue;
            }
            for (const token of manifest.provides) {
                providedTokens.add(token);
            }
            // Pack IDs themselves count as provided
            providedTokens.add(packId);
        }

        // Validate each enabled pack's requirements
        for (const packId of enabledPackIds) {
            const manifest = this.manifests.get(packId);
            if (!manifest) continue;

            for (const req of manifest.requires) {
                if (!providedTokens.has(req) && !enabledSet.has(req)) {
                    errors.push({
                        packId,
                        message: `Pack "${packId}" requires "${req}" but no enabled pack provides it`
                    });
                }
            }
        }

        // Check for duplicate providers
        const providerMap = new Map<string, string[]>();
        for (const packId of enabledPackIds) {
            const manifest = this.manifests.get(packId);
            if (!manifest) continue;
            for (const token of manifest.provides) {
                const existing = providerMap.get(token) ?? [];
                existing.push(packId);
                providerMap.set(token, existing);
            }
        }

        for (const [token, providers] of providerMap) {
            if (providers.length > 1) {
                errors.push({
                    packId: providers[1],
                    message: `Duplicate provider for "${token}": ${providers.join(', ')}`
                });
            }
        }

        return errors;
    }

    resolveBootOrder(enabledPackIds: string[]): IPackManifest[] {
        const errors = this.validateDependencies(enabledPackIds);
        if (errors.length > 0) {
            const details = errors.map(e => `  - [${e.packId}] ${e.message}`).join('\n');
            throw new Error(`Pack dependency validation failed:\n${details}`);
        }

        // Build adjacency: packId -> set of pack IDs it depends on
        const enabledSet = new Set(enabledPackIds);
        const adjacency = new Map<string, Set<string>>();

        // Map token -> providing pack ID for dependency resolution
        const tokenToPackId = new Map<string, string>();
        for (const packId of enabledPackIds) {
            const manifest = this.manifests.get(packId)!;
            for (const token of manifest.provides) {
                tokenToPackId.set(token, packId);
            }
        }

        for (const packId of enabledPackIds) {
            const manifest = this.manifests.get(packId)!;
            const deps = new Set<string>();
            for (const req of manifest.requires) {
                if (enabledSet.has(req)) {
                    if (req !== packId) deps.add(req);
                } else {
                    const provider = tokenToPackId.get(req);
                    if (provider && provider !== packId) deps.add(provider);
                }
            }
            adjacency.set(packId, deps);
        }

        // Topological sort (Kahn's algorithm)
        const correctedInDegree = new Map<string, number>();
        for (const packId of enabledPackIds) {
            correctedInDegree.set(packId, adjacency.get(packId)?.size ?? 0);
        }

        const queue: string[] = [];
        for (const [packId, deg] of correctedInDegree) {
            if (deg === 0) queue.push(packId);
        }
        // Stable sort: alphabetical within same priority
        queue.sort();

        const result: IPackManifest[] = [];
        while (queue.length > 0) {
            const packId = queue.shift()!;
            result.push(this.manifests.get(packId)!);

            // Find packs that depend on this one and decrement their in-degree
            for (const [candidateId, deps] of adjacency) {
                if (deps.has(packId)) {
                    const newDeg = correctedInDegree.get(candidateId)! - 1;
                    correctedInDegree.set(candidateId, newDeg);
                    if (newDeg === 0) {
                        queue.push(candidateId);
                        queue.sort();
                    }
                }
            }
        }

        if (result.length !== enabledPackIds.length) {
            const resolved = new Set(result.map(m => m.id));
            const cycled = enabledPackIds.filter(id => !resolved.has(id));
            throw new Error(`Circular dependency detected among packs: ${cycled.join(', ')}`);
        }

        return result;
    }
}
