/**
 * Pack manifest contract.
 *
 * Every capability pack publishes a manifest so the kernel can
 * validate dependencies, order migrations, and wire registrations.
 */

export interface IPackMigration {
    id: string;
    up(db: unknown): Promise<void>;
    down?(db: unknown): Promise<void>;
}

export interface IPackManifest {
    /** Unique pack identifier, e.g. 'my-pack' */
    id: string;

    /** Semver version string */
    version: string;

    /** Service tokens this pack provides */
    provides: string[];

    /** Service tokens or pack IDs this pack requires */
    requires: string[];

    /** Ordered migrations owned by this pack */
    migrations: IPackMigration[];

    /** Optional CLI command definitions */
    commands?: PackCommandDef[];

    /** Optional tick step registrations */
    tickSteps?: string[];

    /** Optional prompt contributor registrations */
    promptContributors?: string[];

    /** Optional sub-query registrations */
    subQueries?: string[];
}

export interface PackCommandDef {
    name: string;
    description: string;
    args?: string;
    action: (args: Record<string, unknown>, context: unknown) => Promise<void>;
}
