/**
 * Pack bootstrap contract.
 *
 * Each pack provides a bootstrap class that the kernel calls
 * during startup to register services and optionally boot them.
 */

export interface PackBootstrapContext {
    simulationId?: string;
    enabledPacks: string[];
}

export interface IPackBootstrap {
    /** Register services/bindings into the container */
    register(container: unknown, context: PackBootstrapContext): void;

    /** Optional async boot after all packs are registered */
    boot?(container: unknown, context: PackBootstrapContext): Promise<void>;
}
