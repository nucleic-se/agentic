/**
 * Capability registry contract.
 *
 * Manages pack manifests, validates dependency graphs, and
 * resolves boot ordering.
 */

import type { IPackManifest } from './IPackManifest.js';

export interface PackValidationError {
    packId: string;
    message: string;
}

export interface ICapabilityRegistry {
    /** Register a pack manifest */
    registerManifest(manifest: IPackManifest): void;

    /** Get a registered manifest by pack id */
    getManifest(packId: string): IPackManifest | null;

    /** List all registered pack manifests */
    listManifests(): IPackManifest[];

    /**
     * Validate that all enabled packs have their dependencies met.
     * Returns an empty array if valid, otherwise returns errors.
     */
    validateDependencies(enabledPackIds: string[]): PackValidationError[];

    /**
     * Resolve the ordered set of packs that should be activated,
     * respecting dependency order (dependencies before dependents).
     * Throws if validation fails.
     */
    resolveBootOrder(enabledPackIds: string[]): IPackManifest[];
}
