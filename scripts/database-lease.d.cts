export interface DatabaseLease { path: string; holdFileLock(): void; recordLock(database?: import('node-sqlite3-wasm').Database): void; release(): Promise<void> }
export function canonicalDatabasePath(file: string): string;
export function acquireDatabaseLease(file: string): Promise<DatabaseLease>;
export function processBirth(pid: number): string | null;
