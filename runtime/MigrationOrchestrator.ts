/**
 * Pack migration runner.
 *
 * Runs pack migrations in dependency order.
 * Tracks applied migrations to avoid re-running.
 */

import type { IPackManifest } from '../contracts/index.js';

export interface MigrationState {
    isApplied(packId: string, migrationId: string): boolean;
    markApplied(packId: string, migrationId: string): void;
}

/**
 * In-memory migration state tracker.
 * Production use: swap for a persistent implementation.
 */
export class InMemoryMigrationState implements MigrationState {
    private applied = new Set<string>();

    private key(packId: string, migrationId: string): string {
        return `${packId}::${migrationId}`;
    }

    isApplied(packId: string, migrationId: string): boolean {
        return this.applied.has(this.key(packId, migrationId));
    }

    markApplied(packId: string, migrationId: string): void {
        this.applied.add(this.key(packId, migrationId));
    }
}

export class MigrationOrchestrator {
    constructor(
        private state: MigrationState,
        private db: unknown
    ) {}

    /**
     * Run migrations for packs in the given order.
     * Packs should be ordered by dependency (dependencies first).
     */
    async migrate(orderedManifests: IPackManifest[]): Promise<string[]> {
        const applied: string[] = [];

        for (const manifest of orderedManifests) {
            for (const migration of manifest.migrations) {
                if (this.state.isApplied(manifest.id, migration.id)) {
                    continue;
                }
                await migration.up(this.db);
                this.state.markApplied(manifest.id, migration.id);
                applied.push(`${manifest.id}::${migration.id}`);
            }
        }

        return applied;
    }
}
