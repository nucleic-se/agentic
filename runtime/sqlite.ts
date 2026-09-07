export interface SqliteStatement {
    run(...args: unknown[]): { changes: number | bigint };
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
}
export interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }

/** Keep optional driver details behind the same small storage boundary. */
export async function openSqlite(path: string): Promise<SqliteDatabase> {
    let Driver: new (path: string) => SqliteDatabase;
    try {
        const moduleName = 'node:sqlite';
        Driver = (await import(moduleName)).DatabaseSync;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
        const moduleName = 'better-sqlite3';
        try { Driver = (await import(moduleName)).default; }
        catch { throw new Error('SQLite storage requires node:sqlite or optional better-sqlite3'); }
    }
    return new Driver(path);
}
