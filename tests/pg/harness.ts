// Shared plumbing for the PostgreSQL bench tests. Nothing here runs against the
// real whpp: PG_BENCH_CONFIG must name a bench clone (whpp_bench_*), and the
// SQLite side is always a fresh temp copy of SQLITE_SCRATCH.
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import { spawn, type ChildProcess } from "child_process";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { readPgConfig, type PgConfig } from "../../src/backend/pgEngine.ts";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface BenchEnv {
    pgConfigFile: string;
    pgConfig: PgConfig;
    rawConfig: any;
    sqliteSource: string;
}

/** null (tests skip) unless both inputs are given and the target is a bench clone. */
export function benchEnv(): BenchEnv | null {
    const pgConfigFile = process.env.PG_BENCH_CONFIG;
    const sqliteSource = process.env.SQLITE_SCRATCH;
    if (!pgConfigFile || !sqliteSource) return null;
    const rawConfig = JSON.parse(fs.readFileSync(pgConfigFile, "utf-8"));
    const pgConfig = readPgConfig(rawConfig);
    if (!/^whpp_bench_[a-z0-9_]+$/.test(pgConfig.database)) {
        throw new Error(`refusing to test against ${pgConfig.database}: bench clones (whpp_bench_*) only`);
    }
    if (!fs.existsSync(sqliteSource)) throw new Error(`SQLITE_SCRATCH ${sqliteSource} not found`);
    return { pgConfigFile, pgConfig, rawConfig, sqliteSource };
}

/** A private, writable copy of the SQLite snapshot. */
export function sqliteCopy(source: string, label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rtt-pg-${label}-`));
    const file = path.join(dir, "WHPP_Database.db");
    fs.copyFileSync(source, file);
    fs.chmodSync(file, 0o644); // the bench snapshots are read-only files
    alignScratchSchema(file);
    return file;
}

/**
 * The bench snapshot (whpp-sanitized-v2, 2026-09-26) is older than the timer
 * objects PostgreSQL got from schema scripts 0001/0008; the live SQLite file
 * has them from RT-MCS 1.0.32 / this app's migrate(). Give the private copy the
 * same objects (SQLite DDL as RT-MCS FloorEnsureSchema writes it) so both sides
 * answer the same questions. Only ever the temp copy.
 */
function alignScratchSchema(file: string): void {
    const db = new Database(file);
    try {
        const has = (t: string, c?: string) =>
            c
                ? (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${t}') WHERE name = ?`).get(c) as any).n > 0
                : !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
        if (!has("HARNBUILDTIMES", "unitDecision")) db.exec("ALTER TABLE HARNBUILDTIMES ADD COLUMN unitDecision TEXT");
        if (!has("HARNBUILDSEGCREW")) {
            db.exec(`CREATE TABLE HARNBUILDSEGCREW (segmentId INTEGER NOT NULL, buildId INTEGER NOT NULL,
                     builderId INTEGER NOT NULL, PRIMARY KEY (segmentId, builderId))`);
        }
        if (!has("MSTIMERRELEASE")) {
            db.exec(`CREATE TABLE MSTIMERRELEASE (ID INTEGER PRIMARY KEY, BUILDID INTEGER NOT NULL, BUILDERID INTEGER NOT NULL,
                     BYBUILDERID INTEGER, ACTION TEXT NOT NULL, STATION TEXT, VIA TEXT, AT TEXT NOT NULL, WORKEDSECONDS INTEGER, HARN TEXT)`);
        }
    } finally {
        db.close();
    }
}

export function nowLocal(d = new Date()): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// --------------------
// Row comparison
// --------------------

function numeric(v: unknown): number | null {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
    return null;
}

/** One cell: equal, or equal as numbers within 0.011 (julianday vs EXTRACT, printf vs to_char). */
export function sameValue(a: unknown, b: unknown): { same: boolean; typeOnly?: boolean } {
    if (a === b) return { same: true };
    if (a == null || b == null) return { same: false };
    const na = numeric(a);
    const nb = numeric(b);
    if (na != null && nb != null && Math.abs(na - nb) <= 0.011) {
        return typeof a === typeof b ? { same: true } : { same: true, typeOnly: true };
    }
    return { same: false };
}

const sortKey = (r: any) => JSON.stringify(Object.keys(r).sort().map((k) => [k, numeric(r[k]) ?? r[k]]));

export interface RowDiff {
    keysSqlite?: string[];
    keysPg?: string[];
    countSqlite?: number;
    countPg?: number;
    cells: { row: number; key: string; sqlite: unknown; pg: unknown; typeOnly?: boolean }[];
}

export function compareRows(lite: any[], pg: any[], ordered: boolean): RowDiff | null {
    const diff: RowDiff = { cells: [] };
    const k1 = lite.length ? Object.keys(lite[0]) : [];
    const k2 = pg.length ? Object.keys(pg[0]) : [];
    if (lite.length && pg.length && JSON.stringify([...k1].sort()) !== JSON.stringify([...k2].sort())) {
        diff.keysSqlite = k1;
        diff.keysPg = k2;
    }
    if (lite.length !== pg.length) {
        diff.countSqlite = lite.length;
        diff.countPg = pg.length;
    }
    const a = ordered ? lite : [...lite].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
    const b = ordered ? pg : [...pg].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        for (const key of k1) {
            const s = sameValue(a[i][key], b[i][key]);
            if (!s.same || s.typeOnly) diff.cells.push({ row: i, key, sqlite: a[i][key], pg: b[i][key], typeOnly: s.typeOnly });
            if (diff.cells.length > 20) break;
        }
    }
    const real = diff.keysSqlite || diff.countSqlite != null || diff.cells.some((c) => !c.typeOnly);
    return real || diff.cells.length ? diff : null;
}

// --------------------
// The worker's SQLite semantics, for the fake RT-MCS
// --------------------

export function workerRun(db: Database.Database, payload: any): any {
    const runOne = (query: string, params: any[]): any => {
        const stmt = db.prepare(query);
        if (query.trim().toUpperCase().startsWith("SELECT")) return stmt.all(params ?? []);
        const info = stmt.run(params ?? []);
        return { changes: info.changes, lastID: Number(info.lastInsertRowid) };
    };
    try {
        if (Array.isArray(payload.statements)) {
            const results: any[] = [];
            db.transaction(() => {
                for (const s of payload.statements) {
                    const r = runOne(s.query, s.params);
                    if (typeof s.requireChanges === "number" && (!r || r.changes !== s.requireChanges)) {
                        throw new Error(
                            `Expected ${s.requireChanges} row(s) changed but got ${r && r.changes} - rolling back (the row was already handled elsewhere)`
                        );
                    }
                    results.push(r);
                }
            })();
            return { success: true, result: results };
        }
        return { success: true, result: runOne(payload.query, payload.params) };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
}

/**
 * Stands in for RT-MCS on the SQLite engine: /api/timer/exec runs the payload
 * the way the worker does (one transaction, requireChanges), against a scratch
 * copy - so the unchanged SQLite write path can be driven end to end.
 */
export function fakeRtMcs(dbFile: string, port: number): Promise<http.Server> {
    const db = new Database(dbFile);
    db.pragma("busy_timeout = 5000");
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            res.setHeader("Content-Type", "application/json");
            if (req.url === "/api/timer/health") return res.end(JSON.stringify({ ready: true, writable: true, writeError: null }));
            if (req.url === "/api/timer/exec") return res.end(JSON.stringify(workerRun(db, JSON.parse(body || "{}"))));
            if (req.url === "/api/jobs/shipped") return res.end(JSON.stringify({ shipped: [] }));
            res.statusCode = 404;
            res.end(JSON.stringify({ success: false, error: "not in the fake" }));
        });
    });
    server.on("close", () => db.close());
    return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

// --------------------
// The timer's own server
// --------------------

export interface RunningServer {
    proc: ChildProcess;
    log: () => string;
    stop: () => Promise<void>;
    /** The folder holding db-config.json - and pending-writes.jsonl. */
    dir: string;
}

/** server.ts on port 5000 with the given db-config (one at a time: the port is fixed). */
export async function startServer(
    config: object,
    label: string,
    opts: { waitReadable?: boolean; before?: (dir: string) => void } = {}
): Promise<RunningServer> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rtt-srv-${label}-`));
    opts.before?.(dir);
    const cfg = path.join(dir, "db-config.json");
    fs.writeFileSync(cfg, JSON.stringify(config, null, 2));
    let out = "";
    const env: NodeJS.ProcessEnv = { ...process.env, DB_CONFIG_PATH: cfg, WORKER_PATH: path.join(REPO, "src", "backend", "db.worker.cjs") };
    delete env.RTMCS_URL;
    // In-process loader (no tsx CLI child), so killing proc frees the port.
    const proc = spawn(process.execPath, ["--import", "tsx", path.join(REPO, "src", "backend", "server.ts")], {
        cwd: REPO,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout!.on("data", (d) => (out += d));
    proc.stderr!.on("data", (d) => (out += d));
    const deadline = Date.now() + 30_000;
    for (;;) {
        if (proc.exitCode != null) throw new Error(`server exited ${proc.exitCode}:\n${out}`);
        try {
            const r = await fetch("http://localhost:5000/api/db-status", { signal: AbortSignal.timeout(5_000) });
            const s: any = await r.json();
            if (s.readable || opts.waitReadable === false) break;
            if (Date.now() > deadline) throw new Error(`server never readable: ${JSON.stringify(s)}\n${out}`);
        } catch (err) {
            if (Date.now() > deadline) throw new Error(`server never answered: ${err}\n${out}`);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    return {
        proc,
        dir,
        log: () => out,
        stop: () =>
            new Promise((resolve) => {
                if (proc.exitCode != null) return resolve();
                proc.once("exit", () => resolve());
                proc.kill();
            }),
    };
}

export async function api(pathname: string, body?: object): Promise<any> {
    const r = await fetch(`http://localhost:5000${pathname}`, {
        method: body ? "POST" : "GET",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000),
    });
    return r.json();
}
