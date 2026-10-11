export interface SqliteStatement {
    run(...args: unknown[]): { changes: number | bigint };
    get(...args: unknown[]): Record<string, unknown> | undefined;
    all(...args: unknown[]): Array<Record<string, unknown>>;
}
export interface SqliteDatabase { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }

/** Keep optional driver details behind the same small storage boundary. */
export async function openSqlite(path: string, options: { readOnly?: boolean } = {}): Promise<SqliteDatabase> {
    let Driver: new (path: string, options?: object) => SqliteDatabase;
    let native = true;
    try {
        const moduleName = 'node:sqlite';
        Driver = (await import(moduleName)).DatabaseSync;
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ERR_UNKNOWN_BUILTIN_MODULE' && code !== 'ERR_MODULE_NOT_FOUND') throw error;
        native = false;
        const moduleName = 'better-sqlite3';
        try { Driver = (await import(moduleName)).default; }
        catch { throw new Error('SQLite storage requires node:sqlite or optional better-sqlite3'); }
    }
    return new Driver(path, native ? { readOnly: options.readOnly ?? false }
        : { readonly: options.readOnly ?? false, fileMustExist: options.readOnly ?? false });
}
