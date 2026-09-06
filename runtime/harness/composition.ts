import { createHash } from 'node:crypto';

export interface HarnessClient { close(): Promise<void> }
export interface HarnessExtension<Roles extends object, Client extends HarnessClient> {
    id: string;
    version: string;
    apiVersion: 1;
    configuration?: string;
    requires?: string[];
    roles?: { [K in keyof Roles]?: () => Roles[K] | Promise<Roles[K]> };
    activate?(client: Client): Promise<void | (() => void | Promise<void>)>;
}

/** A driver owns admission, persistence and progress, not extension resolution. */
export interface HarnessDriver<Roles extends object, Client extends HarnessClient> {
    roles: readonly (keyof Roles & string)[];
    start(roles: Roles, extensions: HarnessExtension<Roles, Client>[]): Promise<Client>;
    dispose?: { [K in keyof Roles]?: (value: Roles[K]) => void | Promise<void> };
}
export interface DriverComposition<Roles extends object, Client extends HarnessClient> {
    driver: HarnessDriver<Roles, Client>;
    extensions: HarnessExtension<Roles, Client>[];
}

/** Caller-supplied configuration must be non-secret and identify behavior, never credentials. */
export function compositionFingerprint<Roles extends object, Client extends HarnessClient>(extensions: readonly HarnessExtension<Roles, Client>[]): string {
    return createHash('sha256').update(JSON.stringify(extensions.filter(e => Object.keys(e.roles ?? {}).length)
        .map(e => ({ id: e.id, version: e.version, roles: Object.keys(e.roles ?? {}).sort(), configuration: e.configuration })))).digest('hex');
}

/** Validate the complete composition before invoking any factories. */
export async function composeDriver<Roles extends object, Client extends HarnessClient>(
    options: DriverComposition<Roles, Client>,
): Promise<Client> {
    const driver = options.driver;
    const names = [...driver.roles];
    if (new Set(names).size !== names.length) throw new Error('Duplicate driver role');
    const extensions = options.extensions.map(extension => ({ ...extension,
        requires: [...extension.requires ?? []], roles: { ...extension.roles } as NonNullable<HarnessExtension<Roles, Client>['roles']>,
    }));
    const owners = new Map<string, string>();
    const byId = new Map<string, typeof extensions[number]>();
    for (const extension of extensions) {
        if (!/^[a-zA-Z0-9._-]{1,128}$/.test(extension.id)) throw new Error('Invalid identifier');
        if (extension.apiVersion !== 1) throw new Error(`Unsupported extension API: ${extension.id}`);
        if (byId.has(extension.id)) throw new Error(`Duplicate extension: ${extension.id}`);
        byId.set(extension.id, extension);
        for (const role of Object.keys(extension.roles)) {
            if (!names.includes(role as keyof Roles & string)) throw new Error(`Unknown role: ${role}`);
            if (owners.has(role)) throw new Error(`Conflicting owners for ${role}: ${owners.get(role)}, ${extension.id}`);
            if (typeof extension.roles[role as keyof Roles] !== 'function') throw new Error(`Invalid factory for ${role}`);
            owners.set(role, extension.id);
        }
    }
    const missing = names.filter(role => !owners.has(role));
    if (missing.length) throw new Error(`Missing harness roles: ${missing.join(', ')}`);
    const ordered: typeof extensions = [], visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string) => {
        if (visited.has(id)) return;
        if (visiting.has(id)) throw new Error(`Extension dependency cycle: ${id}`);
        const extension = byId.get(id);
        if (!extension) throw new Error(`Missing extension dependency: ${id}`);
        visiting.add(id);
        for (const dependency of extension.requires) visit(dependency);
        visiting.delete(id); visited.add(id); ordered.push(extension);
    };
    for (const id of byId.keys()) visit(id);
    const cleanup: Array<() => void | Promise<void>> = [];
    const dispose = async () => {
        const errors: unknown[] = [];
        for (const callback of cleanup.splice(0).reverse()) {
            try { await callback(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'Harness cleanup failed');
    };
    let client: Client | undefined;
    try {
        const roles = Object.create(null) as Roles;
        for (const extension of ordered) for (const key of Object.keys(extension.roles) as (keyof Roles)[]) {
            const value = await extension.roles[key]!();
            roles[key] = value;
            const release = driver.dispose?.[key];
            if (release) cleanup.push(() => release(value));
        }
        client = await driver.start(roles, ordered);
        const stop = client.close.bind(client);
        let closing: Promise<void> | undefined;
        client.close = () => {
            if (closing) return closing;
            // Stop admission synchronously; keep storage alive until admitted work drains.
            let stopped: Promise<void>;
            try { stopped = stop(); } catch (error) { stopped = Promise.reject(error); }
            closing = (async () => {
                const errors: unknown[] = [];
                try { await stopped; } catch (error) { errors.push(error); }
                try { await dispose(); } catch (error) { errors.push(error); }
                if (errors.length) throw new AggregateError(errors, 'Harness shutdown failed');
            })();
            return closing;
        };
        for (const extension of ordered) {
            const release = await extension.activate?.(client);
            if (release) cleanup.push(release);
        }
        return client;
    } catch (error) {
        try { if (client) await client.close(); else await dispose(); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Harness composition failed'); }
        throw error;
    }
}
