// --------------------
// PostgreSQL engine (db-config "engine": "pg")
// --------------------
// On PostgreSQL the Pi writes the shared WHPP database itself, as the login
// timing_app (RT-MCS refuses its /api/timer/exec proxy there - HPP ruling 27).
// Brief: Harness Pricing Program docs/postgres/PI-PORT-BRIEF.md. This module
// keeps the worker's contract so nothing above it has to change shape:
//   SELECT          -> array of row objects, keyed as the SQL spelled them
//   anything else   -> { changes, lastID }
//   statements[]    -> one transaction, per-statement results, requireChanges
// What it has to add for PostgreSQL:
//   - `?` placeholders become $1..$n;
//   - result keys come back in the case the query wrote them (PostgreSQL folds
//     unquoted names to lowercase; the app reads buildId, REV, Id ...);
//   - lastID comes from RETURNING (no MAX(id) - that was only safe under
//     SQLite's whole-file write lock);
//   - every write transaction runs READ COMMITTED and takes RT-MCS's advisory
//     lock 1380795219 as its first statement (ruling 101: consecutive build ids
//     per batch; and it serialises us with RT-MCS the way the SQLite write lock
//     did), with lock_timeout 15 s like RT-MCS's timer writes;
//   - an insert the ONE PLACE AT A TIME triggers (schema script 0011) can refuse
//     runs under a savepoint, so the refusal surfaces as itself (P0001, same
//     text as SQLite's) instead of as 25P02 on the next statement;
//   - 55P03 (lock timeout) and 40P01 (deadlock) are "database busy": the whole
//     transaction is retried once after 3 s, then reported as busy.
// No DDL ever runs here: the numbered schema scripts own the schema (ruling 1),
// and startup fails closed while whpp_schema is behind (checkSchemaStamp).
import fs from "fs";
import os from "os";
import path from "path";
import pg from "pg";

export const WRITE_LOCK_KEY = 1380795219; // 'RMCS' - RtMcs DbEngine.WriteLockKey
export const LOCK_TIMEOUT_MS = 15_000; // RtMcs TimerExecBusySec
let busyRetryDelayMs = 3_000;
/** The whpp_schema versions this build was written against (SchemaGuard.vb). */
export const REQUIRED_SCHEMA: Record<string, number> = { core: 4, ms: 2 };

export const DEFAULT_PASSWORD_FILE = "~/.config/rt-timing/timing_app.pw";
export const DEFAULT_KEY_FILE = "~/.config/rt-timing/rtmcs.key";

// COUNT/SUM come back as bigint and the duration math as numeric; pg hands both
// over as strings, where better-sqlite3 gave numbers. Every value here is far
// inside a double's exact range.
pg.types.setTypeParser(20, (v) => Number(v)); // int8
pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
// The timer's stamps are TEXT (ruling 79), but should any date-typed column
// reach the app it must stay the server's text, never a UTC-shifted JS Date.
for (const oid of [1082, 1114, 1184]) pg.types.setTypeParser(oid, (v) => v); // date, timestamp, timestamptz

/** A reply that never comes (a dead link with no FIN) must still end the wait:
 *  the RT-MCS proxy gave up after 20 s too. */
const QUERY_TIMEOUT_MS = 25_000;
const IDLE_IN_TX_TIMEOUT_MS = 30_000;

/** Schema script 0011's triggers and 0008's crew table. whpp_schema does not
 *  move for 0004-0019, so the stamp alone cannot tell a database reloaded
 *  without them - and without the triggers ONE PLACE AT A TIME is silently off. */
// Either pair is a live one-place rule: V1 blocks on any other open segment,
// V2 (Timer:PausedFree, Randy 2026-10-16) only on a RUNNING one. Script B swaps
// the pair, and a Pi older than this one would refuse a database that has V2.
const REQUIRED_TRIGGERS: [table: string, triggers: string[]][] = [
    ["harnbuildsegments", ["trg_timer_one_place_seg_v1", "trg_timer_one_place_seg_v2"]],
    ["secondarybuilders", ["trg_timer_one_place_crew_v1", "trg_timer_one_place_crew_v2"]],
];
const REQUIRED_TABLES = ["harnbuildsegcrew"];

export interface PgConfig {
    host: string;
    port: number;
    database: string;
    user: string;
    passwordFile: string;
    keyFile: string;
}

export function expandHome(p: string): string {
    return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * The "pg" block of db-config.json. A password never lives in the config - it
 * is read from passwordFile (Randy, ruling 106; RT-MCS's PgSettings refuses a
 * password key the same way).
 */
export function readPgConfig(config: any): PgConfig {
    const c = config?.pg;
    if (!c || typeof c !== "object") throw new Error('db-config engine is "pg" but has no "pg" block');
    if ("password" in c || "password" in config) {
        throw new Error('db-config must not hold a password - name a "passwordFile" instead');
    }
    const need = (k: string) => {
        if (typeof c[k] !== "string" || c[k] === "") throw new Error(`db-config pg.${k} is missing`);
        return c[k] as string;
    };
    const port = c.port == null ? 5432 : Number(c.port);
    if (!Number.isInteger(port) || port <= 0) throw new Error("db-config pg.port is not a port number");
    return {
        host: need("host"),
        port,
        database: need("database"),
        user: need("user"),
        passwordFile: expandHome(typeof c.passwordFile === "string" && c.passwordFile ? c.passwordFile : DEFAULT_PASSWORD_FILE),
        keyFile: expandHome(typeof c.keyFile === "string" && c.keyFile ? c.keyFile : DEFAULT_KEY_FILE),
    };
}

/** First line of a secret file. The value is never logged. */
export function readSecretFile(file: string, what: string): string {
    let text: string;
    try {
        text = fs.readFileSync(file, "utf-8");
    } catch (err: any) {
        throw new Error(`cannot read the ${what} file ${file}: ${err?.code ?? err}`);
    }
    try {
        // Owner-only, as Randy copies it (chmod 600). Warn, never print it.
        if (process.platform !== "win32" && (fs.statSync(file).mode & 0o077) !== 0) {
            console.warn(`${what} file ${file} is readable by other users - chmod 600 it`);
        }
    } catch { /* the read above already succeeded */ }
    const value = text.split(/\r?\n/)[0].trim();
    if (!value) throw new Error(`the ${what} file ${file} is empty`);
    return value;
}

let pool: pg.Pool | null = null;
let target = "";

export function pgTarget(): string {
    return target;
}

/** `tuning` is for the tests only: the shop always runs the defaults. */
export function openPool(cfg: PgConfig, tuning: { lockTimeoutMs?: number; busyRetryDelayMs?: number } = {}): void {
    busyRetryDelayMs = tuning.busyRetryDelayMs ?? 3_000;
    const password = readSecretFile(cfg.passwordFile, "PostgreSQL password");
    target = `${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`;
    pool = new pg.Pool({
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        password,
        application_name: "rt-timing",
        // Session settings at connect: the ONE PLACE contract asks every writer
        // for a bounded lock wait (0011 header). READ COMMITTED is also set
        // explicitly on every write transaction below.
        // idle_in_transaction_session_timeout: a Pi that dies mid-transaction
        // would otherwise hold the RT-MCS lock until TCP gives up (hours), and
        // every writer on the floor fails with 55P03 meanwhile. Ours never sit
        // idle inside a transaction - statements go back to back.
        options:
            `-c lock_timeout=${tuning.lockTimeoutMs ?? LOCK_TIMEOUT_MS}` +
            ` -c idle_in_transaction_session_timeout=${IDLE_IN_TX_TIMEOUT_MS}`,
        max: 4,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 10_000,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
        query_timeout: QUERY_TIMEOUT_MS,
    });
    // An idle client dropped by the server must not take the process down.
    pool.on("error", (err) => console.warn("PostgreSQL idle client error:", err.message));
    console.log("PostgreSQL engine:", target);
}

export async function closePool(): Promise<void> {
    const p = pool;
    pool = null;
    if (p) await p.end();
}

// --------------------
// SQL text
// --------------------

/** Walks SQL text, calling `onCode` for every stretch outside strings, quoted
 *  identifiers and comments. */
function scanSql(sql: string, onCode: (chunk: string) => string, onOther: (chunk: string) => string = (c) => c): string {
    let out = "";
    let i = 0;
    let codeStart = 0;
    const flush = (end: number) => {
        if (end > codeStart) out += onCode(sql.slice(codeStart, end));
    };
    while (i < sql.length) {
        const ch = sql[i];
        let end = -1;
        if (ch === "'" || ch === '"') {
            end = i + 1;
            for (;;) {
                const j = sql.indexOf(ch, end);
                if (j < 0) { end = sql.length; break; }
                if (sql[j + 1] === ch) { end = j + 2; continue; }
                end = j + 1;
                break;
            }
        } else if (ch === "-" && sql[i + 1] === "-") {
            const j = sql.indexOf("\n", i);
            end = j < 0 ? sql.length : j;
        } else if (ch === "/" && sql[i + 1] === "*") {
            const j = sql.indexOf("*/", i + 2);
            end = j < 0 ? sql.length : j + 2;
        }
        if (end < 0) { i++; continue; }
        flush(i);
        out += onOther(sql.slice(i, end));
        i = end;
        codeStart = end;
    }
    flush(sql.length);
    return out;
}

/** `?` -> `$1..$n`, outside strings and comments. */
export function toPgPlaceholders(sql: string): string {
    let n = 0;
    return scanSql(sql, (code) => code.replace(/\?/g, () => `$${++n}`));
}

/**
 * Column spellings for SELECT * / b.* - the SQLite declarations (PRAGMA
 * table_info on WHPP, 2026-10-14) of the only relations the app reads whole.
 */
const STAR_COLUMNS = [
    // HARNBUILDERS
    "Id", "userName", "password", "privLevel", "active", "qbTimeUserId", "qbAutoPause",
    // HARNBUILDPAUSEREASONS
    "reason_name",
    // HARNBUILDTIMES_VIEW
    "harnBuildTimeId", "buildId", "harnNumber", "REV", "builderId", "timeTypeId", "pauseReasonId",
    "numberOfBuilders", "startTime", "endTime", "openSegments", "workedSeconds", "laborSeconds", "pausedSeconds",
];
const STAR_CASE = new Map(STAR_COLUMNS.map((c) => [c.toLowerCase(), c]));

export interface CaseInfo {
    /** lowercase -> spelling, for names written after AS */
    aliases: Map<string, string>;
    /** lowercase -> every spelling the text uses */
    spellings: Map<string, Set<string>>;
    /** SELECT * or SELECT x.* - those columns come from the table, not the text */
    selectsAll: boolean;
}

export function caseInfo(sql: string): CaseInfo {
    const aliases = new Map<string, string>();
    const spellings = new Map<string, Set<string>>();
    let prevWasAs = false;
    let selectsAll = false;
    scanSql(
        sql,
        (code) => {
            if (/\bSELECT\s+(DISTINCT\s+)?([A-Za-z_][A-Za-z0-9_]*\.)?\*|,\s*[A-Za-z_][A-Za-z0-9_]*\.\*/i.test(code)) {
                selectsAll = true;
            }
            const re = /[A-Za-z_][A-Za-z0-9_$]*|\S/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(code))) {
                const tok = m[0];
                if (!/^[A-Za-z_]/.test(tok)) { prevWasAs = false; continue; }
                const lower = tok.toLowerCase();
                if (prevWasAs && !aliases.has(lower)) aliases.set(lower, tok);
                let set = spellings.get(lower);
                if (!set) spellings.set(lower, (set = new Set()));
                set.add(tok);
                prevWasAs = lower === "as";
            }
            return code;
        },
        (other) => {
            prevWasAs = false;
            return other;
        }
    );
    return { aliases, spellings, selectsAll };
}

/**
 * The key SQLite would have used for a PostgreSQL output column. A quoted name
 * (mixed case or spaces) is already right. Otherwise: the spelling written
 * after AS; for SELECT *, the SQLite declaration (a WHERE that spells the
 * column differently must not rename it); else the one spelling the query
 * uses for it; else the first spelling in the text. Derived from each query's
 * own text, so MSID in one query and msid in another never meet.
 */
export function restoreKey(field: string, info: CaseInfo): string {
    if (field !== field.toLowerCase()) return field;
    const alias = info.aliases.get(field);
    if (alias) return alias;
    const star = STAR_CASE.get(field);
    if (star && info.selectsAll) return star;
    const seen = info.spellings.get(field);
    if (seen && seen.size === 1) return [...seen][0];
    if (star && (!seen || seen.has(star))) return star;
    if (seen && seen.size > 0) return [...seen][0];
    return star ?? field;
}

const caseCache = new Map<string, CaseInfo>();
function cachedCaseInfo(sql: string): CaseInfo {
    let info = caseCache.get(sql);
    if (!info) {
        if (caseCache.size > 500) caseCache.clear();
        info = caseInfo(sql);
        caseCache.set(sql, info);
    }
    return info;
}

function restoreRows(sql: string, result: pg.QueryResult): any[] {
    const info = cachedCaseInfo(sql);
    const keys = result.fields.map((f) => restoreKey(f.name, info));
    return result.rows.map((row: any) => {
        const out: any = {};
        result.fields.forEach((f, i) => { out[keys[i]] = row[f.name]; });
        return out;
    });
}

/** Identity columns of the tables timing_app inserts into (schema loader:
 *  INTEGER PRIMARY KEY -> GENERATED BY DEFAULT AS IDENTITY). */
const IDENTITY_KEY: Record<string, string> = {
    harnbuilds: "buildid",
    harnbuildtimes: "harnbuildtimeid",
    harnbuildsegments: "segmentid",
    secondarybuilders: "secondarybuilderid",
    harnbuilders: "id",
    harnbuildpausereasons: "id",
    mstimerbobbin: "id",
};

function insertTable(sql: string): string | null {
    const m = /^\s*INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
    return m ? m[1].toLowerCase() : null;
}

/** The ONE PLACE AT A TIME triggers fire on these inserts (0011). */
const ONE_PLACE_TABLES = new Set(["harnbuildsegments", "secondarybuilders"]);

function isSelect(sql: string): boolean {
    // The worker's own test, so a statement gets the same result shape here.
    return sql.trim().toUpperCase().startsWith("SELECT");
}

function toPgParams(params: any[] | undefined): any[] {
    // RT-MCS's proxy did the same with booleans: the columns are integers.
    return (params ?? []).map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

export interface Statement {
    query: string;
    params?: any[];
    requireChanges?: number;
}

type Querier = pg.Pool | pg.PoolClient;

/** One statement, as the worker would have answered it. */
async function runOne(db: Querier, stmt: Statement, inTx: boolean): Promise<any> {
    const sql = stmt.query;
    const params = toPgParams(stmt.params);
    if (isSelect(sql)) {
        const r = await db.query(toPgPlaceholders(sql), params);
        return restoreRows(sql, r);
    }
    const table = insertTable(sql);
    const key = table ? IDENTITY_KEY[table] : undefined;
    let text = toPgPlaceholders(sql).replace(/;\s*$/, "");
    if (key && !/\bRETURNING\b/i.test(text)) text += ` RETURNING ${key}`;
    const guarded = inTx && table != null && ONE_PLACE_TABLES.has(table);
    if (guarded) await db.query("SAVEPOINT rt_one_place");
    let r: pg.QueryResult;
    try {
        r = await db.query(text, params);
    } catch (err) {
        // The refusal is what the caller needs to see, even if the rollback
        // to the savepoint fails too (the connection is gone, say).
        if (guarded) await db.query("ROLLBACK TO SAVEPOINT rt_one_place").catch(() => undefined);
        throw err;
    }
    if (guarded) await db.query("RELEASE SAVEPOINT rt_one_place");
    // SQLite's lastInsertRowid is the LAST row an INSERT wrote.
    const lastRow = key && r.rows.length ? r.rows[r.rows.length - 1] : null;
    return { changes: r.rowCount ?? 0, lastID: lastRow ? Number(lastRow[key!]) : 0 };
}

// --------------------
// Errors
// --------------------

const CONNECTION_CODES = new Set(["57P01", "57P02", "57P03", "53300", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
    "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE"]);

export function isConnectionError(err: any): boolean {
    const code = String(err?.code ?? "");
    if (code.startsWith("08") || CONNECTION_CODES.has(code)) return true;
    return /Connection terminated|timeout exceeded when trying to connect|Query read timeout|Client has encountered a connection error|not queryable/i.test(
        String(err?.message ?? "")
    );
}

export function isBusyError(err: any): boolean {
    return err?.code === "55P03" || err?.code === "40P01";
}

/**
 * The message the rest of the app matches on: "PostgreSQL unreachable" and
 * "database busy" are queueable (server.ts isUnreachable); a refusal keeps
 * PostgreSQL's own text, so "ONE PLACE AT A TIME" (crewSlices.ts) still matches.
 */
export function pgErrorMessage(err: any): string {
    const msg = String(err?.message ?? err);
    const code = err?.code ? String(err.code) : "";
    if (isConnectionError(err)) return `PostgreSQL unreachable at ${target}: ${msg}`;
    if (isBusyError(err)) return `database busy - nothing was saved (${code}: ${msg})`;
    return code && /^[0-9A-Z]{5}$/.test(code) ? `${msg} (SQLSTATE ${code})` : msg;
}

// --------------------
// Running statements
// --------------------

let blocked: string | null = "PostgreSQL engine not started";

/** Why nothing may run (schema stamp behind, no pool), or null. */
export function pgBlocked(): string | null {
    return pool ? blocked : "PostgreSQL engine not started";
}

/**
 * Fail closed on the schema stamp (ruling 1): nothing runs while whpp_schema is
 * behind what this build was written for. Called at startup and again by
 * db-status while blocked, so applying the scripts clears it without a restart.
 */
export async function checkSchemaStamp(): Promise<string | null> {
    if (!pool) return (blocked = "PostgreSQL engine not started");
    try {
        const r = await pool.query(
            "SELECT component, version FROM whpp_schema WHERE component = ANY($1::text[])",
            [Object.keys(REQUIRED_SCHEMA)]
        );
        const have = new Map<string, number>(r.rows.map((x: any) => [String(x.component), Number(x.version)]));
        const problems: string[] = [];
        for (const [component, need] of Object.entries(REQUIRED_SCHEMA)) {
            const v = have.get(component);
            if (v == null) problems.push(`${component} has no whpp_schema row (this build needs v${need})`);
            else if (v < need) problems.push(`${component} is v${v} in the database, this build needs v${need}`);
        }
        const trg = await pool.query(
            `SELECT c.relname AS tbl, t.tgname AS trg
               FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
              WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
                AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`
        );
        const live = new Set(trg.rows.map((x: any) => `${x.tbl}.${x.trg}`));
        for (const [table, triggers] of REQUIRED_TRIGGERS) {
            if (!triggers.some((t) => live.has(`${table}.${t}`))) {
                problems.push(`trigger ${triggers[0]} on ${table} is missing or disabled (script 0011)`);
            }
        }
        const tabs = await pool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1::text[])",
            [REQUIRED_TABLES]
        );
        const haveTables = new Set(tabs.rows.map((x: any) => String(x.table_name)));
        for (const t of REQUIRED_TABLES) if (!haveTables.has(t)) problems.push(`table ${t} is missing (script 0008)`);
        blocked = problems.length
            ? `The PostgreSQL schema is behind this timer: ${problems.join("; ")}. ` +
              "The timer never changes the schema - apply the numbered scripts (Scripts\\postgres\\schema) first."
            : null;
    } catch (err) {
        blocked = `cannot read whpp_schema - ${pgErrorMessage(err)}`;
    }
    return blocked;
}

/** A read, or a single write in its own transaction. Worker envelope. */
export async function pgRunPayload(payload: any): Promise<{ success: boolean; result?: any; error?: string }> {
    const why = pgBlocked();
    if (why) return { success: false, error: why };
    try {
        if (Array.isArray(payload?.statements)) {
            return { success: true, result: await pgWriteTx(payload.statements) };
        }
        const stmt: Statement = { query: String(payload?.query ?? ""), params: payload?.params };
        if (isSelect(stmt.query)) return { success: true, result: await runOne(pool!, stmt, false) };
        const [one] = await pgWriteTx([stmt]);
        return { success: true, result: one };
    } catch (err) {
        return { success: false, error: err instanceof Error && (err as any).pgMapped ? err.message : pgErrorMessage(err) };
    }
}

/** The worker's requireChanges refusal, word for word. */
function requireChangesError(want: number, got: number): Error {
    const e: any = new Error(
        `Expected ${want} row(s) changed but got ${got} - rolling back (the row was already handled elsewhere)`
    );
    e.pgMapped = true;
    return e;
}

export type TxRunner = (stmt: Statement) => Promise<any>;

/**
 * One write transaction: BEGIN READ COMMITTED, the RT-MCS advisory lock first,
 * then `work`. `work` may run twice (busy retry), so it must only depend on its
 * inputs. Throws an Error whose message is pgErrorMessage's.
 */
export async function pgWithWriteTx<T>(work: (run: TxRunner) => Promise<T>): Promise<T> {
    const why = pgBlocked();
    if (why) {
        const e: any = new Error(why);
        e.pgMapped = true;
        throw e;
    }
    for (let attempt = 1; ; attempt++) {
        let client: pg.PoolClient | null = null;
        let broken = false;
        let committing = false;
        // A backend that drops while we hold the client emits 'error' on it;
        // note it so the client is destroyed, not returned to the pool.
        const onClientError = () => { broken = true; };
        try {
            client = await pool!.connect();
            client.on("error", onClientError);
            await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
            await client.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK_KEY]);
            const c = client;
            const result = await work((stmt) => runOne(c, stmt, true));
            committing = true;
            await client.query("COMMIT");
            return result;
        } catch (err: any) {
            if (isConnectionError(err)) {
                // Dropping the connection is the rollback: the server aborts
                // the transaction (and frees the lock) when it goes.
                broken = true;
            } else if (client) {
                try {
                    await client.query("ROLLBACK");
                } catch {
                    broken = true;
                }
            }
            if (committing && isConnectionError(err)) {
                // The COMMIT was sent and no answer came: it may have landed.
                // Worded so server.ts isUnreachable does NOT queue it - a
                // replayed pause row would be a second pause row.
                const e: any = new Error(
                    "PostgreSQL went silent during COMMIT - this write may or may not be saved, so it is not retried; check the build before redoing it"
                );
                e.pgMapped = true;
                console.warn("COMMIT outcome unknown:", err?.code, err?.message);
                throw e;
            }
            // Busy, or the link dropped before COMMIT was sent (nothing can have
            // landed): the whole transaction once more, on a fresh connection.
            if ((isBusyError(err) || (isConnectionError(err) && !committing)) && attempt === 1) {
                console.warn("PostgreSQL write failed, retrying once:", pgErrorMessage(err));
                client?.removeListener("error", onClientError);
                client?.release(broken);
                client = null;
                await new Promise((res) => setTimeout(res, busyRetryDelayMs));
                continue;
            }
            if (err?.pgMapped) throw err;
            const e: any = new Error(pgErrorMessage(err));
            e.pgMapped = true;
            e.code = err?.code;
            throw e;
        } finally {
            client?.removeListener("error", onClientError);
            client?.release(broken);
        }
    }
}

/** A statements[] batch: one transaction, the worker's per-statement results. */
export function pgWriteTx(statements: Statement[]): Promise<any[]> {
    return pgWithWriteTx(async (run) => {
        const results: any[] = [];
        for (const s of statements) {
            const r = await run(s);
            if (typeof s.requireChanges === "number" && (!r || r.changes !== s.requireChanges)) {
                throw requireChangesError(s.requireChanges, r?.changes);
            }
            results.push(r);
        }
        return results;
    });
}
