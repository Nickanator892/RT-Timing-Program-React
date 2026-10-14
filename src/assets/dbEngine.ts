/**
 * Which database engine the backend runs: "sqlite" (the shared WHPP file,
 * writes through RT-MCS - the default) or "pg" (PostgreSQL, db-config engine
 * "pg"; see src/backend/pgEngine.ts). App.tsx sets it from /api/db-status
 * before any page renders, so every query below that point sees the right one.
 *
 * Most SQL is the same text on both: the backend turns `?` into $n and gives
 * result keys back in the case the query spelled them. sqlFor is only for the
 * SQLite-only constructs (MAX(a, b), printf, datetime(), COLLATE NOCASE,
 * pragma_table_info, untyped `? IS NULL` ...).
 */
export type DbEngine = "sqlite" | "pg";

let current: DbEngine = "sqlite";

export function setDbEngine(engine: unknown): void {
    current = engine === "pg" ? "pg" : "sqlite";
}

export function dbEngine(): DbEngine {
    return current;
}

export function sqlFor(sqlite: string, pg: string): string {
    return current === "pg" ? pg : sqlite;
}
