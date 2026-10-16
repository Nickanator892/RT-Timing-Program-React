import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import cors from "cors";
import { Worker } from "worker_threads";
import { WriteQueue } from "./writeQueue.js";
import {
  checkSchemaStamp,
  openPool,
  pgBlocked,
  pgRunPayload,
  pgTarget,
  pgWithWriteTx,
  readPgConfig,
  readSecretFile,
  type PgConfig,
} from "./pgEngine.js";

const app = express();
const port = 5000;

// Every segment records the station that opened it. Recovery only ever scans -
// and only ever writes to - rows belonging to THIS station, so two Pis can
// never close each other's live work.
const STATION_ID = os.hostname();

/**
 * Parse a 'YYYY-MM-DD HH:mm:ss' local stamp back to a Date, matching how
 * nowLocal() wrote it. Never use SQL's julianday('now','localtime') against
 * these: SQLite's idea of local time can differ from the process's by hours.
 */
function parseLocalStamp(s: string | null | undefined): Date | null {
    if (!s) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(s).trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return isNaN(d.getTime()) ? null : d;
}

/** Local time as 'YYYY-MM-DD HH:mm:ss' - the format every timestamp column uses. */
function nowLocal(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
        d.getMinutes()
    )}:${p(d.getSeconds())}`;
}

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
  })
);
// Above the 100 kB default: a big /api/build/batch carries every unit's
// segments and crew (up to 500 units). Every other body is far smaller.
app.use(express.json({ limit: "5mb" }));

// --------------------
// Persistent config
// --------------------
const CONFIG_FILE = process.env.DB_CONFIG_PATH ?? path.join(process.cwd(), "db-config.json");
const WORKER_PATH = process.env.WORKER_PATH ?? path.join(process.cwd(), "src/backend/db.worker.cjs");

let dbPath: string | null = null;

// --------------------
// Engine switch
// --------------------
// db-config "engine": "sqlite" (the default, and everything below behaves as it
// always has) or "pg": the shared WHPP database on PostgreSQL, written directly
// as timing_app (pgEngine.ts). Read once at start; switching needs a restart.
type Engine = "sqlite" | "pg";
let engine: Engine = "sqlite";
let pgConfig: PgConfig | null = null;
/** Why the pg engine could not start (bad config, no password file). */
let pgStartError: string | null = null;
let pgKeyTriedAt = Date.now();

/** Is there a database to talk to at all? */
function dbConfigured(): boolean {
  return engine === "pg" ? pgConfig != null : dbPath != null;
}

/** The statement text for the engine in use. Only the SQLite-only constructs
 *  (MAX(a, b), COLLATE NOCASE, sqlite_master, ...) need a second spelling. */
function sqlFor(sqlite: string, pg: string): string {
  return engine === "pg" ? pg : sqlite;
}

// --------------------
// RtMcs write proxy
// --------------------
// Every WRITE goes to RtMcs on the database's Windows host instead of into the
// SQLite file over CIFS. Proven 2026-09-08 on a copy of the database: with the
// mount's nobrl option our locks are invisible to Windows, so HPP/RtMcs treat
// our in-flight journal as abandoned and roll it back ("recovered 2 pages from
// ...-journal") and we end in "disk I/O error"; without nobrl we cannot commit
// at all (SQLite's unix VFS upgrades its shared lock in place at commit, which
// Windows refuses). A Windows-side writer has real locks and a busy timeout,
// so writers queue instead of colliding. Reads stay local.
//
// There is deliberately NO fallback to direct writes when RtMcs is down: that
// would bring the collision straight back. The timer page already holds Start
// while db-status reports not writable, and that is the right behaviour here.
// Contract: docs/RTMCS-TIMER-WRITE-ENDPOINT.md in the Harness Pricing Program repo.
const DEFAULT_RTMCS_URL = "http://192.168.0.199:8322";
let rtmcsUrl: string = process.env.RTMCS_URL ?? DEFAULT_RTMCS_URL;
let rtmcsKey: string | null = null;

// --------------------
// Helpers
// --------------------

process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
});

function validateSQLitePath(candidate: string): void {
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) {
    throw new Error("Path is not a file");
  }
  const fd = fs.openSync(candidate, "r");
  const buf = Buffer.alloc(16);
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  if (buf.toString("utf8", 0, 6) !== "SQLite") {
    throw new Error("File is not a valid SQLite database");
  }
}

/**
 * The journal mode SQLite recorded in the file itself: header byte 18 is the
 * write-format version, and 2 means WAL.
 *
 * Read straight from the header because when this matters we cannot ask the
 * database - the query is what is failing. It turns "disk I/O error" into a
 * sentence that names the actual problem.
 */
function journalModeFromHeader(candidate: string): "wal" | "rollback" | "unknown" {
  try {
    const fd = fs.openSync(candidate, "r");
    const buf = Buffer.alloc(20);
    fs.readSync(fd, buf, 0, 20, 0);
    fs.closeSync(fd);
    if (buf[18] === 2) return "wal";
    if (buf[18] === 1) return "rollback";
    return "unknown";
  } catch {
    return "unknown";
  }
}

// --------------------
// Worker thread runner
// --------------------
/**
 * Local better-sqlite3 worker - reads only, now that writes are proxied.
 *
 * Opened READ-ONLY on purpose. The share is mounted with nobrl, so this side
 * never sees the pricing program's locks: a read that arrives while HPP is
 * mid-commit finds HPP's rollback journal with (apparently) nobody behind it,
 * and a read-write connection would "recover" it - overwriting pages HPP has
 * already committed (seen 2026-09-10: a SUPPBGROUP row and two SPPATHS rows
 * vanished under a live pricing run). A read-only connection refuses instead
 * (SQLITE_READONLY_ROLLBACK, "attempt to write a readonly database"), and
 * runWorker re-serves that read through RtMcs, which holds real locks.
 */
function runWorkerLocal(workerPayload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      console.log("Worker path exists:", fs.existsSync(WORKER_PATH), WORKER_PATH);
        const worker = new Worker(WORKER_PATH, {
            workerData: { dbPath, readonly: true, ...workerPayload },
            env: {
                ...process.env,
                BETTER_SQLITE3_PATH: process.env.BETTER_SQLITE3_PATH ?? 'better-sqlite3'
            }
        });
        worker.on("message", (msg) => {
            // The outcome only, never the rows: they include the RtMcs machine
            // key (loadRtmcsKey) and builder passwords, and main.js copies this
            // output into server.log on the panel.
            console.log(
                "Worker result:",
                !msg?.success
                    ? `failed: ${msg?.error}`
                    : Array.isArray(msg.result)
                      ? `ok, ${msg.result.length} row(s)`
                      : "ok"
            );
            resolve(msg);
        });
        worker.on("error", (err) => {
            console.error("Worker error:", err);
            reject(err);
        });
        worker.on("exit", (code) => {
            console.log("Worker exit code:", code);
            if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
        });
    });
}

/** A batch is always a write; a single statement is a read only if it SELECTs. */
function isWrite(payload: any): boolean {
    if (Array.isArray(payload?.statements)) return true;
    return !/^\s*(SELECT|WITH|PRAGMA)\b/i.test(String(payload?.query ?? ""));
}

/**
 * The shared machine key HPP also presents to RtMcs. RtMcs mints it into
 * MSAPIKEY on its first start, so a plain local read is all it takes.
 */
async function loadRtmcsKey(): Promise<void> {
    rtmcsKey = null;
    if (engine === "pg") {
        // timing_app has no SELECT on msapikey (ruling 106): on PostgreSQL the
        // key lives in a file next to the password, for /api/timer/release only.
        try {
            rtmcsKey = readSecretFile(pgConfig!.keyFile, "RT-MCS machine key");
            console.log("RtMcs machine key loaded from", pgConfig!.keyFile);
        } catch (err) {
            console.warn("RtMcs key not loaded - releases are held until it is:", err instanceof Error ? err.message : err);
        }
        return;
    }
    const out = await runWorkerLocal({
        query: "SELECT KEYVAL FROM MSAPIKEY WHERE KEYNAME = 'HPP'",
        params: [],
    });
    const key = out?.success ? out.result?.[0]?.KEYVAL : null;
    if (typeof key === "string" && key !== "") {
        rtmcsKey = key;
        console.log("RtMcs write proxy:", rtmcsUrl, "(key loaded)");
    } else {
        console.warn("RtMcs key not found in MSAPIKEY - writes are held until it is:", out?.error ?? "no row");
    }
}

/**
 * Forward the worker payload unchanged and hand back RtMcs's reply, which is
 * the worker's own {success, result} / {success:false, error} envelope.
 */
async function runWorkerRemote(workerPayload: any): Promise<any> {
    if (!rtmcsKey) {
        return { success: false, error: "RtMcs key not loaded - the write was not attempted" };
    }
    // RtMcs waits up to 15 s for another writer before answering "database
    // busy" (nothing written). Measured on the live file 2026-09-09: an engine
    // refresh holds the lock for up to 16 s, so one busy answer is normal and
    // a single retry after a short pause covers it. Two in a row is reported.
    for (let attempt = 1; ; attempt++) {
        try {
            const r = await fetch(`${rtmcsUrl}/api/timer/exec`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-RtMcs-Key": rtmcsKey },
                body: JSON.stringify(workerPayload),
                signal: AbortSignal.timeout(20_000),
            });
            const out: any = await r.json().catch(() => null);
            if (!out || typeof out.success !== "boolean") {
                return { success: false, error: `RtMcs answered HTTP ${r.status} without a result envelope` };
            }
            if (!out.success && attempt === 1 && /^database busy/.test(String(out.error ?? ""))) {
                console.warn("RtMcs busy, retrying once:", out.error);
                await new Promise((res) => setTimeout(res, 3_000));
                continue;
            }
            if (!out.success) console.warn("RtMcs refused a write:", out.error);
            return out;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.warn("RtMcs unreachable:", message);
            return { success: false, error: `RtMcs unreachable at ${rtmcsUrl}: ${message}` };
        }
    }
}

/**
 * Reads run in the local worker; every write goes through RtMcs. A local read
 * that fails (hot-journal refusal, "unable to open database file", disk I/O
 * error - all seen during pricing runs) is re-served by RtMcs, whose
 * /api/timer/exec accepts SELECTs. Errors from the SQL itself are not retried:
 * the same statement would fail the same way over there.
 */
async function runWorker(workerPayload: any): Promise<any> {
    // PostgreSQL takes reads and writes alike - there is no file to read and
    // no proxy to write through.
    if (engine === "pg") return pgRunPayload(workerPayload);
    if (isWrite(workerPayload)) return runWorkerRemote(workerPayload);
    let local: any;
    try {
        local = await runWorkerLocal(workerPayload);
    } catch (err) {
        local = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (local?.success || !rtmcsKey) return local;
    const reason = String(local?.error ?? "");
    if (!/readonly|unable to open|disk I[/]O|database is locked|busy|SQLITE_(READONLY|CANTOPEN|IOERR|BUSY)/i.test(reason)) {
        return local;
    }
    console.warn("local read failed (" + reason + ") - re-serving through RtMcs");
    const remote = await runWorkerRemote(workerPayload);
    return remote?.success ? remote : local;
}

/** Can the Windows side take a write lock right now? Nothing is written. */
async function rtmcsHealth(): Promise<{ writable: boolean; writeError?: string }> {
    if (!rtmcsKey) return { writable: false, writeError: "RtMcs key not loaded from MSAPIKEY" };
    try {
        const r = await fetch(`${rtmcsUrl}/api/timer/health`, {
            headers: { "X-RtMcs-Key": rtmcsKey },
            signal: AbortSignal.timeout(5_000),
        });
        if (r.status === 401) return { writable: false, writeError: "RtMcs rejected the machine key" };
        const out: any = await r.json().catch(() => null);
        if (!out) return { writable: false, writeError: `RtMcs answered HTTP ${r.status}` };
        return out.writable
            ? { writable: true }
            : { writable: false, writeError: String(out.writeError ?? "RtMcs cannot take a write lock") };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { writable: false, writeError: `RtMcs unreachable at ${rtmcsUrl}: ${message}` };
    }
}

function runQuery(query: string, params: any[] = []): Promise<any> {
    return runWorker({ query, params });
}

/** All-or-nothing. A statement may carry requireChanges to abort the batch. */
function runTransaction(
    statements: { query: string; params?: any[]; requireChanges?: number }[]
): Promise<any> {
    return runWorker({ statements });
}

/**
 * HARNBUILDSEGCREW - everyone on a segment besides its primary (Randy,
 * 2026-10-07: "record hours per person"; contract shared with the RT-MCS phone
 * timer, see src/assets/crewSlices.ts). RT-MCS 1.0.32 creates it and lets
 * /api/timer/exec write it. Before that RT-MCS is out the table does not exist
 * and an INSERT naming it would be refused - taking the whole Start or roll
 * with it - so no statement names it until the table has been seen. A
 * "present" answer is kept for good; "not yet" is asked again after a minute.
 */
let segCrewSeen = false;
let segCrewCheckedAt = 0;
/**
 * The table existing is not enough: on 2026-10-07 a dev RT-MCS started against
 * the live file by mistake created it while the RT-MCS serving the shop
 * (1.0.31) still refused it - "table not allowed for the timer:
 * HARNBUILDSEGCREW" - so a table-exists check alone would have failed every
 * Start and every crew change. What decides is how RT-MCS answers: a write is
 * sent with its crew rows, and if the proxy refuses the table, the same write
 * goes again without them and this panel stops naming the table until it
 * restarts (the next app start asks again).
 */
let segCrewRefused = false;
function isSegCrewRefusal(err: unknown): boolean {
  return /not allowed[^\n]*HARNBUILDSEGCREW/i.test(String((err as any)?.message ?? err ?? ""));
}
function noteSegCrewRefusal(err: unknown): boolean {
  if (!isSegCrewRefusal(err)) return false;
  if (!segCrewRefused) {
    console.warn("RtMcs refuses HARNBUILDSEGCREW - writing without per-segment crew rows until restart:", String(err));
  }
  segCrewRefused = true;
  return true;
}
/** Whether HARNBUILDSEGCREW can be WRITTEN: it exists and RT-MCS has not
 *  refused it this session. Reading it needs only segCrewExists. */
async function hasSegCrew(): Promise<boolean> {
  if (segCrewRefused) return false;
  return segCrewExists();
}
/** Whether the table exists at all - enough for a read (a SELECT goes through
 *  RT-MCS whatever its allow-list), so names RT-MCS itself pinned are still
 *  found after this panel stopped writing them. */
async function segCrewExists(): Promise<boolean> {
  if (segCrewSeen) return true;
  // On PostgreSQL the table is schema script 0008's and the Pi writes it
  // itself, so it is always there and never refused.
  if (engine === "pg") return (segCrewSeen = true);
  if (Date.now() - segCrewCheckedAt < 60_000) return false;
  segCrewCheckedAt = Date.now();
  const out = await runQuery(
    `SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'HARNBUILDSEGCREW'`,
    []
  );
  segCrewSeen = !!(out?.success && Array.isArray(out.result) && out.result.length > 0);
  return segCrewSeen;
}

// --------------------
// Timer feature switches (Randy, 2026-10-16)
// --------------------
// The RT-MCS phone timer's three 2026-10-16 switches, matched here so the phone
// and the panels go live together (docs/TIMER-PAUSE-PACKAGING-EDIT-DESIGN.md in
// the HPP repo). Each is off unless this station's db-config.json says
//   "timer": { "pausedFree": true, "sharedSessions": true, "timeEdits": true }
// and off means the panel behaves exactly as before. A switch on is still only
// USED once the database has what it needs - the V2 one-place triggers, the
// packaging tables, the time-edit tables - the same rule RT-MCS applies, so a
// panel never offers what the database would refuse.
type TimerSwitches = { pausedFree: boolean; sharedSessions: boolean; timeEdits: boolean };
let timerSwitches: TimerSwitches = { pausedFree: false, sharedSessions: false, timeEdits: false };
function readTimerSwitches(config: any): void {
  const t = config?.timer;
  timerSwitches = {
    pausedFree: t?.pausedFree === true,
    sharedSessions: t?.sharedSessions === true,
    timeEdits: t?.timeEdits === true,
  };
  if (timerSwitches.pausedFree || timerSwitches.sharedSessions || timerSwitches.timeEdits) {
    console.log("timer switches on:", Object.entries(timerSwitches).filter(([, v]) => v).map(([k]) => k).join(", "));
  }
}

const FEATURE_OBJECTS = [
  "trg_timer_one_place_seg_v2",
  "trg_timer_one_place_crew_v2",
  "harnpacksession",
  "harnpacksessionpn",
  "harntimeedit",
  "harntimeeditbuild",
];
let featureCache: { at: number; value: TimerSwitches } | null = null;
/** What this panel may use now: each switch AND the database objects behind it.
 *  Cached for a minute; nothing is asked of the database while every switch is off. */
async function timerFeatures(): Promise<TimerSwitches> {
  const sw = timerSwitches;
  if (!sw.pausedFree && !sw.sharedSessions && !sw.timeEdits) {
    return { pausedFree: false, sharedSessions: false, timeEdits: false };
  }
  if (featureCache && Date.now() - featureCache.at < 60_000) return featureCache.value;
  const list = FEATURE_OBJECTS.map(() => "?").join(", ");
  const out = await runQuery(
    sqlFor(
      `SELECT lower(name) AS name FROM sqlite_master WHERE type IN ('trigger', 'table') AND lower(name) IN (${list})`,
      `SELECT lower(t.tgname) AS name
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
          AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
          AND lower(t.tgname) IN (${list})
       UNION
       SELECT lower(table_name) AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND lower(table_name) IN (${list})`
    ),
    engine === "pg" ? [...FEATURE_OBJECTS, ...FEATURE_OBJECTS] : FEATURE_OBJECTS
  );
  // Unreadable is "not there": the panel then behaves as before.
  const have = new Set<string>(
    out?.success && Array.isArray(out.result) ? out.result.map((r: any) => String(r.name)) : []
  );
  const value = {
    pausedFree: sw.pausedFree && have.has("trg_timer_one_place_seg_v2") && have.has("trg_timer_one_place_crew_v2"),
    sharedSessions: sw.sharedSessions && have.has("harnpacksession") && have.has("harnpacksessionpn"),
    timeEdits: sw.timeEdits && have.has("harntimeedit") && have.has("harntimeeditbuild"),
  };
  if (out?.success) featureCache = { at: Date.now(), value };
  return value;
}

/** RT-MCS's proxy refusing a table this release writes (MSTIMERRELEASE,
 *  HARNPACKSESSION*) - an RT-MCS older than the matching allow-list. */
function isTableRefusal(err: unknown, table: string): boolean {
  return new RegExp(`not allowed[^\\n]*\\b${table}\\b`, "i").test(String((err as any)?.message ?? err ?? ""));
}

/** Throws with the worker's message instead of returning a failure envelope. */
async function mustRun(
    statements: { query: string; params?: any[]; requireChanges?: number }[]
): Promise<any[]> {
    const out = await runTransaction(statements);
    if (!out.success) throw new Error(out.error || "transaction failed");
    return out.result;
}

// --------------------
// Writes that could not reach the database
// --------------------
const writeQueue = new WriteQueue(path.dirname(CONFIG_FILE));
writeQueue.load();

/**
 * Is this failure the database being out of REACH, or the database saying no?
 *
 * Only the first is worth keeping and retrying. A guard that did not match, or
 * a constraint, will fail exactly the same way in ten minutes, and queueing it
 * would tell the operator their work was safe when it never will be.
 */
function isUnreachable(error: unknown): boolean {
    const s = String(error ?? "");
    return /RtMcs unreachable|RtMcs key not loaded|PostgreSQL unreachable|database busy|fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|timed out|abort|readonly|unable to open|disk I[/]O|database is locked|SQLITE_(READONLY|CANTOPEN|IOERR|BUSY)|without a result envelope|HTTP 5\d\d/i.test(
        s
    );
}

let flushing = false;
let lastFlushError: string | null = null;

/**
 * Send what is waiting, oldest first, stopping at the first one that still
 * cannot get through. Order matters: a segment close replayed before the pause
 * that belongs inside it would land on a row that is already finished.
 */
async function flushWriteQueue(): Promise<void> {
    if (flushing || !dbConfigured() || (engine === "sqlite" && !rtmcsKey)) return;
    flushing = true;
    try {
        // While the pg engine refuses to run (not started yet, stamp or 0011
        // objects missing) every replay would come back refused and be PARKED
        // - in memory only, so a restart would lose it. Hold the queue
        // instead, and look at the schema again: after a power cut this tick
        // can come before the startup check has finished.
        if (engine === "pg" && pgBlocked()) {
            if (!pgStartError && writeQueue.pending > 0) await checkSchemaStamp();
            if (pgBlocked()) {
                lastFlushError = pgStartError ?? pgBlocked();
                return;
            }
        }
        for (;;) {
            const entry = writeQueue.peek();
            if (!entry) {
                lastFlushError = null;
                break;
            }
            // A write is replayed only on the engine it was written for: its SQL
            // is that engine's. One left over across the cutover is set aside.
            if ((entry.engine ?? "sqlite") !== engine) {
                writeQueue.park(entry.id, `written for ${entry.engine ?? "sqlite"}, this station now runs ${engine}`);
                continue;
            }
            const out =
                engine === "pg"
                    ? await pgRunPayload({ statements: entry.statements })
                    : await runWorkerRemote({ dbPath, statements: entry.statements });
            if (out?.success) {
                writeQueue.done(entry.id);
                console.log(`write queue: uploaded ${entry.kind} from ${entry.createdAt}`);
                continue;
            }
            const error = String(out?.error ?? "unknown error");
            if (isUnreachable(error)) {
                writeQueue.retryLater(entry.id, error);
                lastFlushError = error;
                break;      // still down; try the whole queue again next tick
            }
            // The database answered and refused. Setting it aside is the only
            // way the rest of the queue ever drains.
            writeQueue.park(entry.id, error);
        }
    } finally {
        flushing = false;
    }
}

/**
 * Run a write, and if the only thing wrong is that the database is out of
 * reach, keep it instead of losing it. Returns what the caller would have got,
 * plus `queued` when it went to the queue.
 */
async function runOrQueue(
    kind: string,
    statements: { query: string; params?: any[]; requireChanges?: number }[]
): Promise<any> {
    const out = await runTransaction(statements);
    if (out?.success) {
        // Back in touch: anything waiting should go now, not in 15 seconds.
        void flushWriteQueue();
        return out;
    }
    const error = String(out?.error ?? "unknown error");
    if (!isUnreachable(error)) return out;
    const entry = writeQueue.add(kind, statements, nowLocal(), engine === "pg" ? "pg" : undefined);
    if (!entry) return out;
    console.warn(`write queue: holding ${kind} locally (${error})`);
    return { success: true, queued: true, pending: writeQueue.pending, error: null };
}

// Every 15s, and immediately after any write that gets through.
setInterval(() => { void flushWriteQueue(); }, 15_000);

// --------------------
// Load DB path on startup
// --------------------
(async () => {
  if (!fs.existsSync(CONFIG_FILE)) return;

  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const config = JSON.parse(raw);
    readTimerSwitches(config);
    if (config.engine === "pg") {
      await startPg(config);
      return;
    }
    if (!config.dbPath) return;

    validateSQLitePath(config.dbPath);
    dbPath = config.dbPath;
    if (typeof config.rtmcsUrl === "string" && config.rtmcsUrl !== "" && !process.env.RTMCS_URL) {
      rtmcsUrl = config.rtmcsUrl;
    }
    console.log("Loaded DB path:", dbPath);
  } catch (err) {
    console.warn("Saved DB path invalid, ignoring:", err);
    dbPath = null;
    return;
  }

  // Schema upkeep is a set of writes, so it runs through RtMcs. If RtMcs is
  // down at boot the schema is simply left as the last start made it - that
  // must NOT unconfigure the database and send the operator to the setup
  // screen, which is what the old single try/catch would have done.
  try {
    await loadRtmcsKey();
    await migrate();
  } catch (err) {
    console.warn("migrate skipped - schema left as-is until the next start:", err);
  }
})();

/**
 * PostgreSQL start. No migrate(): the numbered schema scripts own the schema
 * and timing_app may not change it (ruling 1). Instead the start fails closed
 * on the whpp_schema stamp - while it is behind, db-status reports the
 * database unreadable with the reason and every query is refused.
 */
async function startPg(config: any): Promise<void> {
  try {
    const cfg = readPgConfig(config);
    engine = "pg";
    if (typeof config.rtmcsUrl === "string" && config.rtmcsUrl !== "" && !process.env.RTMCS_URL) {
      rtmcsUrl = config.rtmcsUrl;
    }
    openPool(cfg);
    // Only once there is a pool: a config whose password file cannot be read
    // must not count as a configured database.
    pgConfig = cfg;
  } catch (err) {
    // engine stays "pg" once the config says so: a broken pg config must not
    // quietly fall back to a SQLite path nobody configured.
    engine = "pg";
    pgStartError = err instanceof Error ? err.message : String(err);
    console.warn("PostgreSQL engine not started:", pgStartError);
    return;
  }
  await loadRtmcsKey();
  const blocked = await checkSchemaStamp();
  if (blocked) console.warn("PostgreSQL refused:", blocked);
  else console.log("PostgreSQL schema stamp OK - timer ready on", pgTarget());
}

/** SQLite has no ADD COLUMN IF NOT EXISTS - check pragma first. Idempotent. */
async function ensureColumn(table: string, column: string, decl: string) {
  const info = await runQuery(
    `SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`,
    [column]
  );
  if (info?.success && Number(info.result?.[0]?.n ?? 0) === 0) {
    console.log(`migrate: adding ${table}.${column}`);
    await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

export const INTERRUPTED_PAUSE_REASON = "Interrupted (app closed)";
export const CLOCKED_OUT_PAUSE_REASON = "Clocked out (QuickBooks)";

async function migrate() {
  // --- crash-recovery columns -------------------------------------------
  // accumSeconds is the duration AUTHORITY: the main process's own elapsed
  // counter, which is already pause-free because timer-pause freezes it. It is
  // persisted by heartbeat, so a crash costs at most one cadence interval and
  // always UNDER-credits - it can never inflate labour time.
  await ensureColumn("HARNBUILDSEGMENTS", "accumSeconds", "INTEGER");
  // heartbeatAt is the liveness authority: the last instant the app was proven
  // alive on this segment. Recovery treats it as the moment the operator
  // effectively stopped, and uses it as the pause start when resuming.
  await ensureColumn("HARNBUILDSEGMENTS", "heartbeatAt", "TEXT");
  await ensureColumn("HARNBUILDSEGMENTS", "heartbeatState", "TEXT"); // 'RUN' | 'PAUSE'
  // The station that owns the segment. Recovery only ever scans and writes its
  // OWN station's rows, so two Pis can never close each other's live work.
  await ensureColumn("HARNBUILDSEGMENTS", "stationId", "TEXT");
  // Who was the PRIMARY builder on this segment. HARNBUILDTIMES.builderId can
  // only name one person per build, so before this column a build handed from
  // one builder to another mid-run had to credit all of it to one of them. The
  // segment rows already split on every crew change, so they are the right
  // place for the answer. Additive on purpose: HARNBUILDTIMES_VIEW is NOT
  // changed here (it is kept byte-identical with HPP's copy), so nothing
  // downstream moves - the per-person split is recorded and available, and
  // teaching the view to use it is a separate, cross-repo change.
  await ensureColumn("HARNBUILDSEGMENTS", "builderId", "INTEGER");

  // Historical segments belong to their build's primary builder - the only
  // builder they could have had before handovers were possible.
  await runQuery(`
    UPDATE HARNBUILDSEGMENTS
       SET builderId = (SELECT t.builderId FROM HARNBUILDTIMES t
                         WHERE t.buildId = HARNBUILDSEGMENTS.buildId
                           AND t.timeTypeId <> 4
                         ORDER BY t.harnBuildTimeId LIMIT 1)
     WHERE builderId IS NULL
  `);

  // --- backfill: give historical closed segments an accumSeconds ---------
  // Span minus the pauses that fall inside it, matching what the old
  // span-based math produced, so existing chart values do not move.
  await runQuery(`
    UPDATE HARNBUILDSEGMENTS
       SET accumSeconds = MAX(0, CAST(
             (julianday(endTime) - julianday(startTime)) * 86400
             - COALESCE((SELECT SUM((julianday(p.endTime) - julianday(p.startTime)) * 86400)
                           FROM HARNBUILDTIMES p
                          WHERE p.buildId = HARNBUILDSEGMENTS.buildId
                            AND p.timeTypeId = 4
                            AND p.startTime IS NOT NULL AND p.endTime IS NOT NULL
                            AND length(p.endTime) > 8
                            AND p.startTime >= HARNBUILDSEGMENTS.startTime
                            AND p.startTime <  HARNBUILDSEGMENTS.endTime), 0) AS INTEGER))
     WHERE accumSeconds IS NULL
       AND COALESCE(endTime, '') <> '' AND length(endTime) > 8
       AND COALESCE(startTime, '') <> ''
  `);

  // --- rescue sessions stranded before heartbeats existed ---------------
  // An OPEN segment written by an older build has no accumSeconds and no
  // heartbeatAt, so it would restore showing 00:00:00 and the operator's work
  // would look like it never happened. We cannot know when the app died, but
  // pause rows are hard evidence that it was alive: a pause row is only written
  // on RESUME, so its endTime is a moment the app provably ran. Credit up to
  // the last such moment - the same "last proof of life" rule the heartbeat
  // uses, and equally incapable of over-crediting.
  await runQuery(`
    UPDATE HARNBUILDSEGMENTS
       SET heartbeatAt = COALESCE(
             (SELECT MAX(p.endTime) FROM HARNBUILDTIMES p
               WHERE p.buildId = HARNBUILDSEGMENTS.buildId
                 AND p.timeTypeId = 4
                 AND p.endTime IS NOT NULL AND length(p.endTime) > 8
                 AND p.startTime >= HARNBUILDSEGMENTS.startTime),
             startTime),
           heartbeatState = 'PAUSE'
     WHERE COALESCE(endTime, '') = ''
       AND heartbeatAt IS NULL
       AND COALESCE(startTime, '') <> ''
  `);
  await runQuery(`
    UPDATE HARNBUILDSEGMENTS
       SET accumSeconds = MAX(0, CAST(
             (julianday(heartbeatAt) - julianday(startTime)) * 86400
             - COALESCE((SELECT SUM((julianday(p.endTime) - julianday(p.startTime)) * 86400)
                           FROM HARNBUILDTIMES p
                          WHERE p.buildId = HARNBUILDSEGMENTS.buildId
                            AND p.timeTypeId = 4
                            AND p.startTime IS NOT NULL AND p.endTime IS NOT NULL
                            AND length(p.endTime) > 8
                            AND p.startTime >= HARNBUILDSEGMENTS.startTime
                            AND p.endTime   <= HARNBUILDSEGMENTS.heartbeatAt), 0) AS INTEGER))
     WHERE COALESCE(endTime, '') = ''
       AND accumSeconds IS NULL
       AND heartbeatAt IS NOT NULL
       AND COALESCE(startTime, '') <> ''
  `);

  for (const reason of [INTERRUPTED_PAUSE_REASON, CLOCKED_OUT_PAUSE_REASON]) {
    await runQuery(
      `INSERT INTO HARNBUILDPAUSEREASONS (reason_name, active)
       SELECT ?, 1 WHERE NOT EXISTS (SELECT 1 FROM HARNBUILDPAUSEREASONS WHERE reason_name = ?)`,
      [reason, reason]
    );
  }

  // --- extra-units decision (Build mode) ---------------------------------
  // Best-effort, matching another agent's own migration on the RT-MCS side:
  // both converge on the same column existing, and ensureColumn is idempotent
  // either way. 'EXTRA' | 'SPREAD' | NULL on the build's non-pause
  // HARNBUILDTIMES row(s) - see timingPage.tsx's extra-units question. The Pi
  // may run this release before RT-MCS is republished, so every reader and
  // writer of this column has to tolerate it being absent (see
  // carryoverGuard-adjacent code in timingPage.tsx, timeDistribution.ts,
  // useTimes.ts and useJobs.ts) rather than depend on this ALTER having run.
  await ensureColumn("HARNBUILDTIMES", "unitDecision", "TEXT");

  // --- QuickBooks Time clock link ---------------------------------------
  // Which QuickBooks Time user a builder is, and whether their clock state is
  // allowed to drive the timer. Opt-in per person: office staff are in
  // QuickBooks Time too but must never pause a build.
  await ensureColumn("HARNBUILDERS", "qbTimeUserId", "INTEGER");
  await ensureColumn("HARNBUILDERS", "qbAutoPause", "INTEGER");

  // Written by the poller on the Windows host (Scripts/qbtime-poller.ps1),
  // which is the only process holding the API token. Created here as well so
  // the app works if it starts first - the stations never call Intuit.
  await runQuery(`CREATE TABLE IF NOT EXISTS QBTIMEUSERS (
                    qbTimeUserId INTEGER PRIMARY KEY,
                    displayName  TEXT,
                    username     TEXT,
                    active       INTEGER,
                    updatedAt    TEXT)`);
  await runQuery(`CREATE TABLE IF NOT EXISTS QBTIMESTATUS (
                    qbTimeUserId INTEGER PRIMARY KEY,
                    onTheClock   INTEGER,
                    shiftSeconds INTEGER,
                    checkedAt    TEXT)`);
  // lastPollAt is the freshness gate. If the poller dies, clock state is
  // UNKNOWN - and unknown must never be treated as clocked out, or a dead
  // poller would pause every station on the floor.
  await runQuery(`CREATE TABLE IF NOT EXISTS QBTIMEPOLL (
                    id         INTEGER PRIMARY KEY CHECK (id = 1),
                    lastPollAt TEXT,
                    lastError  TEXT)`);

  // Recreate (not IF NOT EXISTS) so an old definition in the DB gets
  // replaced. The old h.* + aliased-aggregate shape looked right but never
  // worked: better-sqlite3 does NOT merge duplicate column names - it
  // suffixes the later ones (":1"), so consumers read h's always-NULL
  // startTime/endTime and every chart duration came out 0. Explicit columns
  // give the aggregate the real names, and GROUP BY harnBuildTimeId (the
  // row id) keeps pause rows (same buildId, timeTypeId 4) from collapsing
  // into their build row and randomly hijacking its timeTypeId.
  //
  // -- HBTV v4 (keep byte-identical with the copy in HPP's
  //             BuildTimerScheduleForm.EnsureTimingTables; bump both together)
  //
  // laborSeconds (v4) is the same time weighted by how many people worked it:
  // two builders on one harness for an hour earn two labour hours, and a build
  // can change crew mid-run, so the weighting is per SEGMENT rather than per
  // build. workedSeconds stays the honest wall-clock figure - the two answer
  // different questions and neither replaces the other. Costing and per-person
  // analytics want laborSeconds; "how long will this take on the bench" wants
  // workedSeconds.
  await runQuery(`DROP VIEW IF EXISTS HARNBUILDTIMES_VIEW`);
  await runQuery(`
      CREATE VIEW HARNBUILDTIMES_VIEW AS
      SELECT
          h.harnBuildTimeId,
          h.buildId,
          h.harnNumber,
          h.REV,
          h.builderId,
          h.timeTypeId,
          h.pauseReasonId,
          h.numberOfBuilders,
          MIN(s.startTime) as startTime,
          MAX(s.endTime) as endTime,
          SUM(CASE WHEN COALESCE(s.endTime, '') = '' THEN 1 ELSE 0 END) AS openSegments,
          SUM(COALESCE(s.accumSeconds, 0)) AS workedSeconds,
          SUM(COALESCE(s.accumSeconds, 0) * COALESCE(s.numberOfBuilders, 1)) AS laborSeconds,
          (SELECT COALESCE(SUM((julianday(p.endTime) - julianday(p.startTime)) * 86400), 0)
             FROM HARNBUILDTIMES p
            WHERE p.buildId = h.buildId
              AND p.timeTypeId = 4
              AND p.startTime IS NOT NULL
              AND p.endTime IS NOT NULL
              AND length(p.endTime) > 8) AS pausedSeconds
      FROM HARNBUILDTIMES h
      LEFT JOIN HARNBUILDSEGMENTS s ON h.buildId = s.buildId
      GROUP BY h.harnBuildTimeId
  `);
  // workedSeconds must NEVER have pausedSeconds subtracted from it:
  // accumSeconds is already pause-free, so subtracting would double-count
  // every pause. pausedSeconds stays exported for display only.
  // openSegments is the in-progress flag: MAX(endTime) alone cannot express it
  // because SQLite ranks '' below every timestamp, so a build with one closed
  // and one open segment reports the closed stamp and reads as finished.
  console.log("migrate: schema and view up to date");
}

// --------------------
// Routes
// --------------------

/**
 * Which scheduled jobs are finished work: every unit they owed has shipped -
 * the RT-MCS board's own Completed test (RtMcs JobState.cs, Randy 2026-10-07:
 * completed jobs ghost off the screen like on the board). Asked of RT-MCS
 * rather than worked out here, so the panel can never disagree with the office
 * screen. Read-only and public on RT-MCS; on any failure the Choose Kit page
 * just shows every job as live.
 */
app.get("/api/jobs/shipped", async (_req, res) => {
  try {
    const r = await fetch(`${rtmcsUrl}/api/jobs/shipped`, { signal: AbortSignal.timeout(5_000) });
    const out: any = await r.json().catch(() => null);
    if (!r.ok || !out || !Array.isArray(out.shipped)) {
      return res.json({ success: false, error: String(out?.error ?? `RtMcs answered HTTP ${r.status}`) });
    }
    res.json({ success: true, shipped: out.shipped.map(Number).filter(Number.isFinite) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ success: false, error: `RtMcs unreachable at ${rtmcsUrl}: ${message}` });
  }
});

/**
 * Per harness of one job: what it owes and what has shipped (RT-MCS JobState.cs,
 * the board's own split) - the packaging checklist's "not fully shipped" default
 * (Randy 2026-10-16, design section 2). Asked of RT-MCS like /api/jobs/shipped;
 * on any failure the checklist falls back to the scheduled quantities.
 */
app.get("/api/jobs/shipstate", async (req, res) => {
  const msid = Number(req.query?.msid);
  if (!(msid > 0)) return res.status(400).json({ success: false, error: "msid is required" });
  try {
    const r = await fetch(`${rtmcsUrl}/api/jobs/shipstate?msid=${encodeURIComponent(String(msid))}`, {
      signal: AbortSignal.timeout(5_000),
    });
    const out: any = await r.json().catch(() => null);
    if (!r.ok || !out || !Array.isArray(out.pns)) {
      return res.json({ success: false, error: String(out?.error ?? `RtMcs answered HTTP ${r.status}`) });
    }
    res.json({
      success: true,
      pns: out.pns.map((p: any) => ({ pn: String(p?.pn ?? ""), owed: Number(p?.owed) || 0, shipped: Number(p?.shipped) || 0 })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ success: false, error: `RtMcs unreachable at ${rtmcsUrl}: ${message}` });
  }
});

/** Which of the 2026-10-16 timer features this panel uses now (timerFeatures). */
app.get("/api/timer/features", async (_req, res) => {
  if (!dbConfigured()) return res.json({ success: true, result: { pausedFree: false, sharedSessions: false, timeEdits: false } });
  try {
    res.json({ success: true, result: { ...(await timerFeatures()), switches: timerSwitches, station: STATION_ID } });
  } catch (err) {
    res.json({ success: true, result: { pausedFree: false, sharedSessions: false, timeEdits: false }, error: String(err) });
  }
});

/**
 * `ready` deliberately keeps its old meaning - configured, present and a real
 * SQLite file - because App.tsx sends the operator to the database SETUP screen
 * when it is false. A share that is merely read-only is not a reason to ask
 * anyone to re-type the path, so writability is reported separately and the
 * timer page is what acts on it.
 */
app.get("/api/db-status", async (_req, res) => {
  if (engine === "pg") return res.json(await pgStatus());
  if (!dbPath) {
    return res.json({ ready: false, writable: false, error: "No database path configured" });
  }
  try {
    validateSQLitePath(dbPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.json({ ready: false, writable: false, error: message });
  }

  // Opening the file is not proof the database can be USED, so actually ask it
  // something. On 2026-09-06 the shared database was switched to WAL journal
  // mode by a desktop tool; WAL needs shared memory an SMB mount cannot give,
  // so every query died with "disk I/O error" while this endpoint cheerfully
  // reported ready AND writable - both of its file checks pass under WAL. The
  // bench showed an empty builder list all morning and nothing here noticed.
  const probe = await runQuery("SELECT 1 AS ok", []);
  if (!probe?.success) {
    const mode = journalModeFromHeader(dbPath);
    const detail =
      mode === "wal"
        ? "the database is in WAL journal mode, which does not work over a network share - switch it back with PRAGMA journal_mode=DELETE"
        : String(probe?.error ?? "the database did not answer a test query");
    console.warn("Database not usable:", detail);
    // readable:false is what tells the login page this is the database itself
    // (it shows the builder list), not the RtMcs write path the timer page reports.
    return res.json({ ready: true, readable: false, writable: false, writeError: detail, journalMode: mode });
  }

  // A start (or a path change) while the database could not be read left the
  // RtMcs key unloaded, and every write would stay held "key not loaded" until
  // a restart. The database answers now, so read the key again.
  if (!rtmcsKey) await loadRtmcsKey().catch((err) => console.warn("RtMcs key reload failed:", err));

  // Writes happen on the Windows host, so ask RtMcs whether IT can take a
  // write lock right now. The old r+ open of the file only proved the share
  // was not read-only, which says nothing about the writer we actually use.
  const remote = await rtmcsHealth();
  if (!remote.writable) console.warn("Database is not writable:", remote.writeError);
  // Back in touch with something waiting: send it now rather than waiting for
  // the next tick, so the warning on the panel clears as soon as it is true.
  if (remote.writable && writeQueue.pending > 0) void flushWriteQueue();
  res.json({
    ready: true,
    readable: true,
    writable: remote.writable,
    writeError: remote.writeError,
    writer: rtmcsUrl,
    // What the panel needs to say "held here, not lost". pending returns to 0
    // only once every queued write has been confirmed by the database, which is
    // what makes the warning self-clearing rather than time-based.
    pendingWrites: writeQueue.pending,
    pendingOldest: writeQueue.oldestAt,
    // Writes the database actively REFUSED. These will not clear on their own
    // and someone has to look at them, so they are reported separately.
    rejectedWrites: writeQueue.parkedCount,
    queueError: lastFlushError,
  });
});

/**
 * db-status on PostgreSQL, same fields. `ready` stays true for a configured
 * engine (false would send the operator to the SQLite path screen); what is
 * wrong - unreachable, schema behind, bad config - is readable:false with the
 * reason, which the login page shows. A test query is the proof, as on SQLite.
 */
async function pgStatus(): Promise<any> {
  const base = { engine: "pg", writer: pgTarget() };
  if (pgStartError || !pgConfig) {
    return { ...base, ready: true, readable: false, writable: false, writeError: pgStartError ?? "PostgreSQL not configured" };
  }
  // Fail closed until the stamp is right, but look again each time: the
  // scripts may have been applied since.
  if (pgBlocked()) await checkSchemaStamp();
  const probe = await runQuery("SELECT 1 AS ok", []);
  if (!probe?.success) {
    const detail = String(probe?.error ?? "the database did not answer a test query");
    console.warn("Database not usable:", detail);
    return { ...base, ready: true, readable: false, writable: false, writeError: detail };
  }
  // A missing key file is looked for again, but not on every poll.
  if (!rtmcsKey && Date.now() - pgKeyTriedAt > 5 * 60_000) {
    pgKeyTriedAt = Date.now();
    await loadRtmcsKey();
  }
  if (writeQueue.pending > 0) void flushWriteQueue();
  return {
    ...base,
    ready: true,
    readable: true,
    writable: true,
    writeError: undefined,
    pendingWrites: writeQueue.pending,
    pendingOldest: writeQueue.oldestAt,
    rejectedWrites: writeQueue.parkedCount,
    queueError: lastFlushError,
  };
}

/** Detail for anyone diagnosing a queue that is not draining. */
app.get("/api/write-queue", (_req, res) => {
  res.json({
    success: true,
    result: {
      file: writeQueue.path,
      pending: writeQueue.pending,
      oldest: writeQueue.oldestAt,
      lastError: lastFlushError,
      rejected: writeQueue.parkedEntries().map((e) => ({
        kind: e.kind, createdAt: e.createdAt, attempts: e.attempts, error: e.lastError,
      })),
    },
  });
});

// --------------------
// Crash recovery
// --------------------

/**
 * Persist how much this segment has earned so far, and prove the app is alive.
 * Fire-and-forget from the main process; a failure must never disturb the timer.
 */
let heartbeatQueue: Promise<unknown> = Promise.resolve();
app.post("/api/heartbeat", async (req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  const { segmentId, accumSeconds, state } = req.body ?? {};
  if (!segmentId) return res.status(400).json({ success: false, error: "segmentId is required" });
  try {
    // accumSeconds only ever moves forward: a stale/duplicate heartbeat can
    // never claw back time the operator actually worked. That is also what
    // makes a heartbeat safe to queue and replay late - an old one landing
    // after a newer one changes nothing.
    // One at a time, in the order they arrive - main sends them in order, but
    // gives up waiting on one after 8 s while this keeps going (a lock wait
    // can be 16 s), and without the queue the next could overtake it at the
    // database: a stale PAUSE landing last on a running segment, which RT-MCS
    // then credits nothing for if it releases the build. The state and the
    // stamp are taken when the write actually runs, in that order.
    const accum = Math.max(0, Math.floor(Number(accumSeconds) || 0));
    const heartbeatState = state === "PAUSE" ? "PAUSE" : "RUN";
    const run = heartbeatQueue.then(() => {
      // A fresh heartbeat makes any for this segment still queued from an
      // outage pointless (its accumSeconds is at least theirs) - and replayed
      // AFTER it, an old PAUSE would overwrite a running segment's state, which
      // the 1.0.29 updater reads as safe to restart under.
      writeQueue.discard(
        (e) => e.kind === "heartbeat" && Number(e.statements?.[0]?.params?.[4]) === Number(segmentId)
      );
      return runOrQueue("heartbeat", [
        {
          query: `UPDATE HARNBUILDSEGMENTS
            SET heartbeatAt = ?, heartbeatState = ?,
                accumSeconds = ${sqlFor("MAX", "GREATEST")}(COALESCE(accumSeconds, 0), ?),
                stationId = COALESCE(stationId, ?)
          WHERE segmentId = ? AND COALESCE(endTime, '') = ''`,
          params: [nowLocal(), heartbeatState, accum, STATION_ID, segmentId],
        },
      ]);
    });
    heartbeatQueue = run.catch(() => undefined);
    const out = await run;
    res.json(out);
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * The one open segment this station left behind, if any. Station-scoped: a Pi
 * must never see - let alone touch - another station's live work.
 *
 * The scan also adopts segments whose stationId IS NULL: those were left open
 * by a version that predates heartbeats, and they are exactly the sessions this
 * feature exists to rescue. Without that clause the builds already stranded in
 * the database would stay invisible forever. Such rows always classify as
 * STALE, so they are offered to the operator rather than restored silently.
 *
 * Returns { recovery: null } when there is nothing to recover.
 */
app.get("/api/recovery/scan", async (_req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  try {
    const out = await runQuery(
      `SELECT s.segmentId, s.buildId, s.startTime, s.heartbeatAt, s.heartbeatState,
              COALESCE(s.accumSeconds, 0)  AS segmentAccumSeconds,
              s.numberOfBuilders,
              b.harnNumber, h.REV, h.builderId, h.timeTypeId,
              bl.userName AS builderName,
              (SELECT COALESCE(SUM(COALESCE(accumSeconds, 0)), 0)
                 FROM HARNBUILDSEGMENTS WHERE buildId = s.buildId) AS buildAccumSeconds,
              (SELECT MIN(startTime) FROM HARNBUILDSEGMENTS WHERE buildId = s.buildId) AS buildStartTime
         FROM HARNBUILDSEGMENTS s
         JOIN HARNBUILDS       b  ON b.buildId = s.buildId
         JOIN HARNBUILDTIMES   h  ON h.buildId = s.buildId AND h.timeTypeId <> 4
    LEFT JOIN HARNBUILDERS     bl ON bl.Id = h.builderId
        WHERE COALESCE(s.endTime, '') = ''
          AND (s.stationId = ? OR s.stationId IS NULL)
        ORDER BY s.segmentId DESC
        LIMIT 1`,
      [STATION_ID]
    );
    if (!out?.success) return res.status(500).json(out);
    const row = out.result?.[0];
    if (!row) return res.json({ success: true, recovery: null });

    // Age is computed with the SAME clock that wrote the timestamp. SQLite's
    // julianday('now','localtime') can disagree with the process's local time by
    // hours (observed: 6), which made a fresh crash look like it happened in
    // the future and could equally hide a genuinely stale one.
    const beat = parseLocalStamp(row.heartbeatAt) ?? parseLocalStamp(row.startTime);
    const hoursSinceHeartbeat = beat ? (Date.now() - beat.getTime()) / 3_600_000 : Number.NaN;

    // Legacy rows (pre-heartbeat) can only be credited what the operator can
    // vouch for, so they are surfaced but never auto-restored. A negative age
    // means the clock moved backwards (a Pi has no RTC and may not have reached
    // NTP yet) - treat that as unknown rather than fresh.
    const status =
      !row.heartbeatAt || !Number.isFinite(hoursSinceHeartbeat) || hoursSinceHeartbeat < -0.1 || hoursSinceHeartbeat > 12
        ? "STALE"
        : "RECOVERABLE";
    res.json({
      success: true,
      recovery: { ...row, hoursSinceHeartbeat, status, stationId: STATION_ID },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * Start a build. One transaction so a crash can never leave a half-built
 * record: the recovery scan JOINs all three tables, so a torn start would be
 * invisible to it and its time unrecoverable.
 *
 * It used to be two transactions - the HARNBUILDS insert first, to learn the
 * new buildId, then everything else - so a start refused by the database
 * (RT-MCS's one-place-at-a-time triggers, 2026-09-13) rolled back only the
 * second half and left an empty HARNBUILDS row behind on every refusal.
 * The later statements now find the id inside the same transaction: the
 * first INSERT holds the write lock until COMMIT, so no other writer can add
 * a build in between and MAX(buildId) is this one.
 */
//
// On PostgreSQL there is no whole-database write lock to lean on, so the ids
// come from the identity sequences instead: currval() is this transaction's own
// session's last value - the row it just inserted, whatever other writers do
// (the same answer RT-MCS's FloorTimer gets from lastval()). The transaction
// also holds the RT-MCS advisory lock from its first statement (pgEngine.ts).
const SQLITE_NEW_BUILD_ID = `(SELECT MAX(buildId) FROM HARNBUILDS)`;
const PG_NEW_BUILD_ID = `currval(pg_get_serial_sequence('harnbuilds', 'buildid'))`;
const PG_NEW_SEGMENT_ID = `currval(pg_get_serial_sequence('harnbuildsegments', 'segmentid'))`;
app.post("/api/build/start", async (req, res) => {
  const NEW_BUILD_ID = sqlFor(SQLITE_NEW_BUILD_ID, PG_NEW_BUILD_ID);
  const NEW_SEGMENT_ID = sqlFor(`(SELECT MAX(segmentId) FROM HARNBUILDSEGMENTS WHERE buildId = ${NEW_BUILD_ID})`, PG_NEW_SEGMENT_ID);
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  const { harnNumber, rev, builderId, timeTypeId, numberOfBuilders, secondaryBuilderIds, startTime, unitDecision, pack } =
    req.body ?? {};
  if (!harnNumber) return res.status(400).json({ success: false, error: "harnNumber is required" });
  // Timer:SharedSessions packaging session (Randy 2026-10-16, design section
  // 2): the live Packaging time is an ordinary build on the first checked
  // harness, and the session row with its checked harnesses goes in with it,
  // in the same transaction - RT-MCS FloorPackStart's rows exactly, but with
  // this station's name. Submit splits it (timingPage submitBatch).
  let packRows: { pn: string; qty: number }[] = [];
  if (pack != null) {
    if (!(await timerFeatures()).sharedSessions) {
      return res.status(409).json({ success: false, error: "Packaging sessions are not switched on for this station." });
    }
    const merged = new Map<string, { pn: string; qty: number }>();
    for (const p of Array.isArray(pack?.pns) ? pack.pns : []) {
      const pn = String(p?.pn ?? "").trim();
      const qty = Math.floor(Number(p?.qty) || 0);
      if (!pn || qty <= 0) continue;
      const key = pn.toUpperCase();
      const had = merged.get(key);
      merged.set(key, { pn: had?.pn ?? pn, qty: (had?.qty ?? 0) + qty });
    }
    packRows = [...merged.values()];
    if (!(Number(pack?.msid) > 0)) return res.status(400).json({ success: false, error: "pack.msid is required" });
    if (!packRows.length) {
      return res.status(400).json({ success: false, error: "Check at least one harness and how many you are packaging." });
    }
    if (packRows.reduce((t, p) => t + p.qty, 0) > 500) {
      return res.status(400).json({ success: false, error: "At most 500 harnesses in one packaging session." });
    }
    if (packRows[0].pn.toUpperCase() !== String(harnNumber).trim().toUpperCase()) {
      return res.status(400).json({ success: false, error: "A packaging session's build is on its first checked harness." });
    }
  }
  const start = startTime || nowLocal();
  // finding [7]: nobody is the builder AND the second operator. Every current
  // client caller already filters secondaryBuilderIds against the primary
  // before sending it, but that guarantee only holds as long as every caller
  // remembers to - this endpoint is the actual authority over the write, so
  // it filters again server-side and recomputes numberOfBuilders from the
  // filtered list rather than trusting the client-supplied count.
  const primary = Number(builderId) > 0 ? Number(builderId) : null;
  // Unique as well: a repeated id would break HARNBUILDSEGCREW's primary key
  // and take the whole Start down with it.
  const filteredSecondaryIds = [...new Set((Array.isArray(secondaryBuilderIds) ? secondaryBuilderIds : []).map(Number))].filter(
    (id: number) => id > 0 && (primary == null || id !== primary)
  );
  const builders = Math.max(1, filteredSecondaryIds.length + 1);
  void numberOfBuilders; // superseded by the recomputed `builders` above.
  const decision = unitDecision === "EXTRA" || unitDecision === "SPREAD" ? unitDecision : null;

  // finding [5]: recordAsNewBuild used to flag the extra-units decision with a
  // SEPARATE, non-queueable UPDATE issued right after this insert. If that
  // UPDATE failed (e.g. a transient lock) the build+segment created here were
  // already committed, and recordAsNewBuild never surfaces their ids to app
  // state - so the failure orphaned an open segment with nothing anywhere
  // pointing at it, and a Submit retry created another orphan on top. Writing
  // the decision INTO this same INSERT/transaction makes it atomic with the
  // build's own creation: either both land, or neither does and there is
  // nothing to orphan. Column-tolerant: HARNBUILDTIMES.unitDecision is added
  // by this app's own migrate() (see ensureColumn above), which is skipped
  // entirely while RtMcs is unreachable - if the column is not there yet,
  // insert without it and log, rather than failing the whole build/start.
  function buildStatements(withDecisionColumn: boolean, withSegCrew: boolean) {
    return [
      { query: `INSERT INTO HARNBUILDS (harnNumber) VALUES (?)`, params: [harnNumber], requireChanges: 1 },
      withDecisionColumn
        ? {
            query: `INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders, unitDecision)
                    VALUES (${NEW_BUILD_ID}, ?, ?, ?, ?, ?, ?)`,
            params: [harnNumber, rev ?? null, builderId ?? null, timeTypeId ?? 1, builders, decision],
            requireChanges: 1,
          }
        : {
            query: `INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders)
                    VALUES (${NEW_BUILD_ID}, ?, ?, ?, ?, ?)`,
            params: [harnNumber, rev ?? null, builderId ?? null, timeTypeId ?? 1, builders],
            requireChanges: 1,
          },
      {
        query: `INSERT INTO HARNBUILDSEGMENTS
                  (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId)
                VALUES (${NEW_BUILD_ID}, ?, '', ?, 0, ?, 'RUN', ?, ?)`,
        params: [start, builders, start, STATION_ID, builderId ?? null],
        requireChanges: 1,
      },
      ...filteredSecondaryIds.map((id: any) => ({
        query: `INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (${NEW_BUILD_ID}, ?)`,
        params: [id],
      })),
      // Who else is on the first segment (crew contract, see hasSegCrew).
      ...(withSegCrew ? filteredSecondaryIds : []).map((id: any) => ({
        query: `INSERT INTO HARNBUILDSEGCREW (segmentId, buildId, builderId)
                VALUES (${NEW_SEGMENT_ID}, ${NEW_BUILD_ID}, ?)`,
        params: [id],
      })),
      ...(packRows.length ? packStatements() : []),
    ];
  }

  // Found by its build: the session id is never needed before its own rows
  // go in, and this works whatever the id column is on either engine.
  function packStatements() {
    const NEW_PACK_ID = `(SELECT MAX(PACKID) FROM HARNPACKSESSION WHERE BUILDID = ${NEW_BUILD_ID})`;
    return [
      {
        query: `INSERT INTO HARNPACKSESSION (MSID, REV, BUILDID, STATUS, CREATED, CREATEDBY, STATIONID)
                VALUES (?, ?, ${NEW_BUILD_ID}, 'OPEN', ?, ?, ?)`,
        params: [Number(pack.msid), rev ?? null, start, builderId ?? null, STATION_ID],
        requireChanges: 1,
      },
      ...packRows.map((p, i) => ({
        query: `INSERT INTO HARNPACKSESSIONPN (PACKID, PN, QTY, SEQ) VALUES (${NEW_PACK_ID}, ?, ?, ?)`,
        params: [p.pn, p.qty, i],
        requireChanges: 1,
      })),
      { query: `SELECT ${NEW_PACK_ID} AS packId`, params: [] },
    ];
  }

  try {
    let withSegCrew = await hasSegCrew();
    let withDecision = decision != null;
    let out;
    // Each fallback is taken at most once: an RT-MCS that refuses the crew
    // table, and a database without unitDecision yet.
    for (;;) {
      try {
        out = await mustRun(buildStatements(withDecision, withSegCrew));
        break;
      } catch (err) {
        if (withSegCrew && noteSegCrewRefusal(err)) {
          withSegCrew = false;
          continue;
        }
        if (withDecision && /(no such column|has no column named).*unitDecision/i.test(String(err))) {
          console.warn("build/start: HARNBUILDTIMES.unitDecision not present yet - inserting without it:", err);
          withDecision = false;
          continue;
        }
        throw err;
      }
    }
    const buildId = Number(out[0].lastID);
    const packId = packRows.length ? Number(out[out.length - 1]?.[0]?.packId ?? 0) || null : null;
    res.json({ success: true, result: { buildId, segmentId: Number(out[2].lastID), startTime: start, packId } });
  } catch (err) {
    if (packRows.length && isTableRefusal(err, "HARNPACKSESSION(PN)?")) {
      return res.status(409).json({
        success: false,
        error: "This RT-MCS does not take packaging sessions from a timer station yet - nothing was started.",
      });
    }
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * Close the current segment and open its replacement atomically (used when the
 * builder roster changes mid-build). Between the two statements the build has
 * NO open segment, and RtMcs's timer sweep reads that as a finished build and
 * proposes consuming inventory for it - hence one transaction.
 *
 * `builderId` is the PRIMARY builder from here on. Send it when the build has
 * been handed to someone else: the segment that just closed keeps the builder
 * it was worked by, the new one is stamped with the new primary, and the build
 * row follows the person who is on it now. Omit it and only the second-operator
 * roster changes, which is the older crew-change case.
 */
app.post("/api/build/segment-roll", async (req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  const { buildId, segmentId, accumSeconds, numberOfBuilders, secondaryBuilderIds, builderId, running, takeover } =
    req.body ?? {};
  if (!buildId || !segmentId) {
    return res.status(400).json({ success: false, error: "buildId and segmentId are required" });
  }
  const now = nowLocal();
  // Timer:PausedFree (Randy 2026-10-16). A roll made while the clock is stopped
  // opens the new segment PAUSED, not RUN: with the V2 triggers a paused build
  // may share its people with a running one elsewhere, and a RUN insert would
  // be refused for them. Off, every new segment opens RUN as it always has.
  // `takeover` - someone else picking up a PAUSED build here: audited in
  // MSTIMERRELEASE as TAKEOVER (the old primary's notice), in this transaction.
  const features = await timerFeatures();
  const newState = features.pausedFree && running === false ? "PAUSE" : "RUN";
  const audit =
    features.pausedFree && takeover && Number(takeover.fromBuilderId) > 0 && Number(builderId) > 0
      ? {
          query: `INSERT INTO MSTIMERRELEASE (BUILDID, BUILDERID, BYBUILDERID, ACTION, STATION, VIA, AT, WORKEDSECONDS, HARN)
                  VALUES (?, ?, ?, 'TAKEOVER', ?, ?, ?, ?, ?)`,
          params: [
            Number(buildId), Number(takeover.fromBuilderId), Number(builderId), STATION_ID, `station:${STATION_ID}`, now,
            Math.max(0, Math.floor(Number(takeover.workedSeconds) || 0)), String(takeover.harn ?? ""),
          ],
        }
      : null;
  // A handover names the incoming builder; a plain crew change does not, and
  // must leave both the build row and the new segment on whoever is already
  // recorded - never NULL them.
  const newPrimary = Number(builderId) > 0 ? Number(builderId) : null;
  void numberOfBuilders; // superseded by the recomputed `builders` below.
  try {
    // finding [7]: same server-side backstop as /api/build/start - filter
    // secondaryBuilderIds against the RESOLVED primary (the incoming handover
    // target, or, on a plain crew change, whoever the build is already
    // recorded against) and recompute numberOfBuilders from the filtered
    // list, instead of trusting the client-supplied array and count.
    let resolvedPrimary = newPrimary;
    if (resolvedPrimary == null) {
      const primaryLookup = await runQuery(
        `SELECT builderId FROM HARNBUILDTIMES WHERE buildId = ? AND timeTypeId <> 4 ORDER BY harnBuildTimeId LIMIT 1`,
        [buildId]
      );
      if (primaryLookup?.success) {
        resolvedPrimary = Number(primaryLookup.result?.[0]?.builderId ?? 0) || null;
      }
    }
    const filteredSecondaryIds = [...new Set((Array.isArray(secondaryBuilderIds) ? secondaryBuilderIds : []).map(Number))].filter(
      (id: number) => id > 0 && (resolvedPrimary == null || id !== resolvedPrimary)
    );
    const builders = Math.max(1, filteredSecondaryIds.length + 1);
    // Built twice at most: with the crew rows, and - if RT-MCS refuses the
    // table (see isSegCrewRefusal) - the same roll without them.
    const rollStatements = (withSegCrew: boolean) => {
    const statements: { query: string; params?: any[]; requireChanges?: number }[] = [
      {
        query: `UPDATE HARNBUILDSEGMENTS
                   SET endTime = ?, accumSeconds = ${sqlFor("MAX", "GREATEST")}(COALESCE(accumSeconds, 0), ?), heartbeatAt = ?
                 WHERE segmentId = ? AND COALESCE(endTime, '') = '' AND stationId = ?`,
        params: [now, Math.max(0, Math.floor(Number(accumSeconds) || 0)), now, segmentId, STATION_ID],
        requireChanges: 1,
      },
    ];
    if (withSegCrew) {
      // A segment opened before HARNBUILDSEGCREW existed (or by a Pi release
      // older than this one) has its people only in SECONDARYBUILDERS, which
      // the DELETE below is about to replace. Pin them to the segment that is
      // closing first, or a helper who leaves now loses every second they
      // worked. Same rule as RT-MCS's own rolls.
      statements.push({
        query: `INSERT INTO HARNBUILDSEGCREW (segmentId, buildId, builderId)
                SELECT DISTINCT ${sqlFor("?, ?", "?::integer, ?::integer")}, sb.builderId FROM SECONDARYBUILDERS sb
                 WHERE sb.buildId = ?
                   AND sb.builderId <> COALESCE((SELECT s.builderId FROM HARNBUILDSEGMENTS s WHERE s.segmentId = ?), -1)
                   AND (SELECT COALESCE(s.numberOfBuilders, 1) FROM HARNBUILDSEGMENTS s WHERE s.segmentId = ?) > 1
                   AND NOT EXISTS (SELECT 1 FROM HARNBUILDSEGCREW c WHERE c.segmentId = ?)`,
        params: [segmentId, buildId, buildId, segmentId, segmentId, segmentId],
      });
    }
    const newSegmentAt = statements.length;
    statements.push(
      {
        // COALESCE, not the raw value: on a plain crew change newPrimary is
        // null and the new segment inherits the builder the build already has.
        query: `INSERT INTO HARNBUILDSEGMENTS
                  (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId)
                VALUES (?, ?, '', ?, 0, ?, ?, ?,
                        COALESCE(?, (SELECT t.builderId FROM HARNBUILDTIMES t
                                      WHERE t.buildId = ? AND t.timeTypeId <> 4
                                      ORDER BY t.harnBuildTimeId LIMIT 1)))`,
        params: [buildId, now, builders, now, newState, STATION_ID, newPrimary, buildId],
        requireChanges: 1,
      },
      {
        query: `UPDATE HARNBUILDTIMES
                   SET numberOfBuilders = ?, builderId = COALESCE(?, builderId)
                 WHERE buildId = ? AND timeTypeId <> 4`,
        params: [builders, newPrimary, buildId],
      },
      { query: `DELETE FROM SECONDARYBUILDERS WHERE buildId = ?`, params: [buildId] },
      ...filteredSecondaryIds.map((id: any) => ({
        query: `INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)`,
        params: [buildId, id],
      })),
      // The new segment's crew, in the same transaction that opens it. A crew
      // member the database refuses (ONE PLACE AT A TIME, on the
      // SECONDARYBUILDERS insert above) takes the whole roll down with them.
      ...(withSegCrew ? filteredSecondaryIds : []).map((id: any) => ({
        query: `INSERT INTO HARNBUILDSEGCREW (segmentId, buildId, builderId)
                VALUES (${sqlFor("(SELECT MAX(segmentId) FROM HARNBUILDSEGMENTS WHERE buildId = ?)", PG_NEW_SEGMENT_ID)}, ?, ?)`,
        params: engine === "pg" ? [buildId, id] : [buildId, buildId, id],
      }))
    );
    if (withAudit && audit) statements.push(audit);
    return { statements, newSegmentAt };
    };
    let withSegCrew = await hasSegCrew();
    let withAudit = audit != null;
    let roll = rollStatements(withSegCrew);
    let out;
    // Each fallback at most once: an RT-MCS that refuses the crew table, and
    // one whose allow-list does not have MSTIMERRELEASE yet (the takeover
    // still happens, as a plain handover, and says so in the log).
    for (;;) {
      try {
        out = await mustRun(roll.statements);
        break;
      } catch (err) {
        if (withSegCrew && noteSegCrewRefusal(err)) {
          withSegCrew = false;
        } else if (withAudit && isTableRefusal(err, "MSTIMERRELEASE")) {
          console.warn("segment-roll: RtMcs refuses MSTIMERRELEASE - takeover recorded without its audit row:", String(err));
          withAudit = false;
        } else {
          throw err;
        }
        roll = rollStatements(withSegCrew);
      }
    }
    res.json({
      success: true,
      // audited: only for a takeover - whether its TAKEOVER row went in.
      result: { segmentId: Number(out[roll.newSegmentAt].lastID), startTime: now, audited: audit ? withAudit : undefined },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * A batch's units in ONE transaction (PostgreSQL only). timeDistribution.ts
 * still works out every unit's rows; on SQLite it writes them one /api/query
 * at a time as it always has. On PostgreSQL that would interleave build ids
 * with any other station's batch - the advisory lock is released at every
 * commit - and RT-MCS groups a session's units by consecutive build ids
 * (TimingSessions.cs, u.B == prev.B + 1; ruling 101). So the page posts the
 * units here and they are written under one lock, ids from RETURNING. Same
 * statements, same order, as writeDistributedTimes.
 */
app.post("/api/build/batch", async (req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  if (engine !== "pg") {
    return res.status(400).json({ success: false, error: "/api/build/batch is the PostgreSQL engine's batch write" });
  }
  const { harnNumber, rev, timeTypeId, writeSegCrew, units } = req.body ?? {};
  if (!harnNumber) return res.status(400).json({ success: false, error: "harnNumber is required" });
  if (!Array.isArray(units) || units.length < 1 || units.length > 500) {
    return res.status(400).json({ success: false, error: "units must list 1 to 500 units" });
  }
  const id = (v: any) => (Number(v) > 0 ? Number(v) : null);
  try {
    const buildIds = await pgWithWriteTx(async (run) => {
      const ids: number[] = [];
      for (const u of units) {
        const builderId = id(u?.builderId);
        // A packaging session's units each sit on their own harness (planDistributedTimes unitHarns).
        const unitHarn = typeof u?.harnNumber === "string" && u.harnNumber ? u.harnNumber : harnNumber;
        const insert = await run({ query: "INSERT INTO HARNBUILDS (harnNumber) VALUES(?)", params: [unitHarn] });
        const buildId = Number(insert?.lastID ?? 0);
        if (!buildId) throw new Error("Failed to create build row");
        ids.push(buildId);
        if (u?.unitDecision === "EXTRA" || u?.unitDecision === "SPREAD") {
          await run({
            query: `INSERT INTO HARNBUILDTIMES
                    (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders, unitDecision)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`,
            params: [buildId, unitHarn, rev ?? null, builderId, timeTypeId, u.numberOfBuilders, u.unitDecision],
          });
        } else {
          await run({
            query: "INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders) VALUES(?, ?, ?, ?, ?, ?)",
            params: [buildId, unitHarn, rev ?? null, builderId, timeTypeId, u.numberOfBuilders],
          });
        }
        for (const s of Array.isArray(u?.segments) ? u.segments : []) {
          const primaryId = id(s?.builderId);
          const segment = await run({
            query: `INSERT INTO HARNBUILDSEGMENTS
                    (buildId, startTime, endTime, numberOfBuilders, accumSeconds, builderId)
                 VALUES(?, ?, ?, ?, ?, ?)`,
            params: [buildId, s.startTime, s.endTime, s.numberOfBuilders, s.accumSeconds, primaryId],
          });
          const segmentId = Number(segment?.lastID ?? 0);
          if (writeSegCrew && segmentId) {
            for (const crewId of Array.isArray(s?.crewIds) ? s.crewIds : []) {
              if (Number(crewId) === Number(primaryId ?? -1)) continue;
              await run({
                query: "INSERT INTO HARNBUILDSEGCREW (segmentId, buildId, builderId) VALUES (?, ?, ?)",
                params: [segmentId, buildId, crewId],
              });
            }
          }
        }
        for (const secondaryId of Array.isArray(u?.secondaryIds) ? u.secondaryIds : []) {
          if (Number(secondaryId) === Number(builderId ?? -1)) continue;
          await run({ query: "INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)", params: [buildId, secondaryId] });
        }
      }
      return ids;
    });
    res.json({ success: true, result: { buildIds } });
  } catch (err) {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Drop a build that is still LIVE on this station - the single-build rows
 * written at Start - because the operator switched it to a batch mid-run and
 * Submit is about to write the batch's units instead. Hands back the build's
 * pause rows so the batch can carry them, and its segment rows and crew so the
 * batch can give each unit the people who worked it. One transaction, and the
 * guard on the HARNBUILDS delete (an OPEN segment on this station) means a build that was
 * already submitted, or belongs to another station, can never be discarded.
 */
// --------------------
// Cirris handoff inbox
// --------------------
// The test station stages a timer rather than starting one: it writes a row to
// RTCT_ShopHandoff, the panel offers it, and accepting preloads the harness,
// mode and unit count so the operator only has to press Start. Contract:
// RT-Cirris-Test-Program docs/whpp/HPP-STAGE-THE-TIMER-2026-09-12.md.
//
// Reads run locally like every other read. The two WRITES - claiming a row and
// answering it - go through RtMcs, which since v1.0.2 allows this table
// UPDATE-only. Both of ours are UPDATEs, and nothing here ever inserts or
// deletes, which is also why it is safe for the proxy to refuse those.
//
// "Live offer" is Response IS NULL: the tester's sweep stamps EXPIRED on rows
// nobody ever claimed. It never touches a row once SeenAt is set, so a row this
// station claims is ours alone to resolve - see the stale-claim sweep below,
// which is the ONLY thing that will ever resolve one left by an instance that
// died holding it.
const HANDOFF_KINDS = ["OFFER_TIMING_PN", "OFFER_TIMING"];

/** Offers waiting for this station, newest first. Read-only. */
app.get("/api/handoff/pending", async (_req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  try {
    const out = await runQuery(
      `SELECT HandoffId, Kind, FromApp, FromStation, HarnPn, Rev, TimeTypeId, BatchUnits, Note,
              CreatedAt, ExpiresAt
         FROM RTCT_ShopHandoff
        WHERE ToApp = 'TIMING'
          AND Kind IN (${HANDOFF_KINDS.map(() => "?").join(",")})
          AND SeenAt IS NULL
          AND Response IS NULL
          AND (ExpiresAt IS NULL OR ExpiresAt > ?)
        ORDER BY HandoffId DESC`,
      [...HANDOFF_KINDS, nowLocal()]
    );
    if (!out?.success) return res.status(500).json({ success: false, error: out?.error });
    res.json({ success: true, result: out.result });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * Take ownership before anything is drawn. requireChanges 1 on SeenAt IS NULL
 * is what stops two panels popping the same offer: the loser changes no rows
 * and is told so, rather than both showing a dialog for one harness.
 */
app.post("/api/handoff/claim", async (req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  const handoffId = Number(req.body?.handoffId);
  if (!handoffId) return res.status(400).json({ success: false, error: "handoffId is required" });
  try {
    await mustRun([
      {
        query: `UPDATE RTCT_ShopHandoff
                   SET SeenAt = ?, ToStation = COALESCE(ToStation, ?)
                 WHERE HandoffId = ? AND SeenAt IS NULL AND Response IS NULL`,
        params: [nowLocal(), STATION_ID, handoffId],
        requireChanges: 1,
      },
    ]);
    res.json({ success: true, result: { handoffId, claimed: true } });
  } catch (err) {
    // Someone else got there first, or it was answered in between. Not an
    // error worth showing anyone - the caller just drops the offer.
    res.json({ success: true, result: { handoffId, claimed: false, reason: String(err) } });
  }
});

/**
 * Answer a claimed row. ACCEPTED, DECLINED, or EXPIRED when the dialog aged out
 * or was dismissed - a claimed row left unanswered is resolved by nobody, and
 * at a 30-minute lifetime that window is six times wider than it used to be.
 */
app.post("/api/handoff/respond", async (req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  const handoffId = Number(req.body?.handoffId);
  const response = String(req.body?.response ?? "").toUpperCase();
  if (!handoffId) return res.status(400).json({ success: false, error: "handoffId is required" });
  if (!["ACCEPTED", "DECLINED", "EXPIRED"].includes(response)) {
    return res.status(400).json({ success: false, error: `bad response: ${response}` });
  }
  try {
    const out = await runOrQueue(`handoff ${response.toLowerCase()}`, [
      {
        query: `UPDATE RTCT_ShopHandoff
                   SET Response = ?, RespondedAt = ?
                 WHERE HandoffId = ? AND Response IS NULL`,
        params: [response, nowLocal(), handoffId],
      },
    ]);
    if (!out?.success) return res.status(500).json({ success: false, error: out.error });
    res.json({ success: true, result: { handoffId, response }, queued: out.queued === true });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * Rows this station claimed and never answered - an instance that died holding
 * one. Nothing on the Cirris side will ever resolve these, by their explicit
 * guarantee, so if this does not do it nothing will. Run at startup AND
 * periodically: the panel can be up for days, and a row claimed at 09:00 by a
 * renderer that crashed should not wait for the next power cut.
 */
async function sweepStaleClaims(): Promise<number> {
  if (!dbConfigured() || (engine === "sqlite" && !rtmcsKey)) return 0;
  try {
    const stale = await runQuery(sqlFor(
      // COLLATE NOCASE on the station: a hostname is not case-sensitive, and
      // the same machine really does arrive spelled differently depending on
      // who wrote the row - os.hostname() gives "RandyMartens-PC" where
      // %COMPUTERNAME% gives "RANDYMARTENS-PC". Compared exactly, this sweep
      // silently resolves nothing, which is the one failure nobody would
      // notice: the rows it exists to clean up are invisible to begin with.
      `SELECT HandoffId FROM RTCT_ShopHandoff
        WHERE ToApp = 'TIMING' AND SeenAt IS NOT NULL AND Response IS NULL
          AND (ToStation IS NULL OR ToStation = ? COLLATE NOCASE)
          AND (ExpiresAt IS NULL OR ExpiresAt < ?)`,
      `SELECT HandoffId FROM RTCT_ShopHandoff
        WHERE ToApp = 'TIMING' AND SeenAt IS NOT NULL AND Response IS NULL
          AND (ToStation IS NULL OR lower(ToStation) = lower(?::text))
          AND (ExpiresAt IS NULL OR ExpiresAt < ?)`),
      [STATION_ID, nowLocal()]
    );
    const rows: any[] = stale?.success && Array.isArray(stale.result) ? stale.result : [];
    for (const r of rows) {
      await runOrQueue("handoff expired", [
        {
          query: `UPDATE RTCT_ShopHandoff SET Response = 'EXPIRED', RespondedAt = ?
                   WHERE HandoffId = ? AND Response IS NULL`,
          params: [nowLocal(), Number(r.HandoffId)],
        },
      ]);
      console.log(`handoff: resolved stale claim ${r.HandoffId} as EXPIRED`);
    }
    return rows.length;
  } catch (err) {
    console.warn(`handoff sweep failed: ${err}`);
    return 0;
  }
}

app.post("/api/handoff/sweep", async (_req, res) => {
  const n = await sweepStaleClaims();
  res.json({ success: true, result: { resolved: n } });
});

// Every 5 minutes, and once shortly after startup.
setTimeout(() => { void sweepStaleClaims(); }, 20_000);
setInterval(() => { void sweepStaleClaims(); }, 5 * 60_000);

app.post("/api/build/discard", async (req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  const buildId = Number(req.body?.buildId);
  if (!buildId) return res.status(400).json({ success: false, error: "buildId is required" });
  // Built twice at most, like a roll: without the crew table's statements if
  // RT-MCS refuses them (see isSegCrewRefusal).
  const discardStatements = (readCrew: boolean, withSegCrew: boolean) => [
      {
        query: `SELECT startTime, endTime, pauseReasonId FROM HARNBUILDTIMES
                 WHERE buildId = ? AND timeTypeId = 4 ORDER BY startTime`,
        params: [buildId],
      },
      {
        query: `DELETE FROM HARNBUILDS
                 WHERE buildId = ?
                   AND EXISTS (SELECT 1 FROM HARNBUILDSEGMENTS s
                                WHERE s.buildId = HARNBUILDS.buildId
                                  AND COALESCE(s.endTime, '') = '' AND s.stationId = ?)`,
        params: [buildId, STATION_ID],
        requireChanges: 1,
      },
      // Who worked which segment, read in the same transaction that drops it:
      // the batch gives every unit a share of every segment, with that
      // segment's people (timingPage submitBatch). SECONDARYBUILDERS is the
      // LATEST roster only - every roll replaces it - so it names the crew of
      // the open segment and nothing earlier; HARNBUILDSEGCREW names the rest.
      {
        query: `SELECT segmentId, builderId, numberOfBuilders, accumSeconds, startTime, endTime
                  FROM HARNBUILDSEGMENTS WHERE buildId = ? ORDER BY segmentId`,
        params: [buildId],
      },
      { query: `SELECT builderId FROM SECONDARYBUILDERS WHERE buildId = ?`, params: [buildId] },
      readCrew
        ? { query: `SELECT segmentId, builderId FROM HARNBUILDSEGCREW WHERE buildId = ?`, params: [buildId] }
        : { query: sqlFor(`SELECT 0 AS segmentId WHERE 0`, `SELECT 0 AS segmentId WHERE false`), params: [] },
      { query: `DELETE FROM HARNBUILDSEGMENTS WHERE buildId = ?`, params: [buildId] },
      { query: `DELETE FROM SECONDARYBUILDERS WHERE buildId = ?`, params: [buildId] },
      { query: `DELETE FROM HARNBUILDTIMES WHERE buildId = ?`, params: [buildId] },
      ...(withSegCrew ? [{ query: `DELETE FROM HARNBUILDSEGCREW WHERE buildId = ?`, params: [buildId] }] : []),
  ];
  try {
    const readCrew = await segCrewExists();
    let withSegCrew = await hasSegCrew();
    let out;
    try {
      out = await mustRun(discardStatements(readCrew, withSegCrew));
    } catch (err) {
      if (!(withSegCrew && noteSegCrewRefusal(err))) throw err;
      withSegCrew = false;
      out = await mustRun(discardStatements(readCrew, false));
    }
    res.json({
      success: true,
      result: {
        pauses: Array.isArray(out[0]) ? out[0] : [],
        segments: Array.isArray(out[2]) ? out[2] : [],
        crewIds: Array.isArray(out[3]) ? out[3].map((r: any) => Number(r.builderId)).filter((n: number) => n > 0) : [],
        // null, not []: "no table yet" and "nobody else on any segment" must
        // stay distinguishable to the batch.
        segCrew: readCrew && Array.isArray(out[4]) ? out[4] : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/** Whether HARNBUILDSEGCREW can be written - the table exists and RT-MCS has
 *  not refused it this session - for the batch writes, which the page makes
 *  itself through /api/query (see hasSegCrew). */
app.get("/api/build/crew-table", async (_req, res) => {
  if (!dbConfigured()) return res.status(400).json({ success: false, error: "Database not configured" });
  // station: this panel's name on its segments, so the page can treat a build
  // open on THIS station the way the one-place triggers do.
  res.json({ success: true, result: { present: await hasSegCrew(), station: STATION_ID } });
});

/**
 * Randy, 2026-10-07: "anyone can end/submit a blocking time". When the
 * database refuses someone ONE PLACE AT A TIME, the panel offers to end the
 * build that blocks them, wherever it is open. RT-MCS does the work (it owns
 * the rule: a blocked PRIMARY's build is ended and submitted, a blocked crew
 * member is rolled off it, and every release is audited in MSTIMERRELEASE);
 * this only carries the request with the machine key, the same way every
 * write goes. `builderId` is the blocked person, `buildId` the blocking build,
 * `byBuilderId` whoever pressed the button here.
 */
app.post("/api/timer/release", async (req, res) => {
  const builderId = Number(req.body?.builderId);
  const buildId = Number(req.body?.buildId);
  const byBuilderId = Number(req.body?.byBuilderId) || undefined;
  if (!(builderId > 0) || !(buildId > 0)) {
    return res.status(400).json({ success: false, error: "builderId and buildId are required" });
  }
  if (!rtmcsKey) return res.status(503).json({ success: false, error: "RtMcs key not loaded - nothing was released" });
  try {
    const r = await fetch(`${rtmcsUrl}/api/timer/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-RtMcs-Key": rtmcsKey },
      body: JSON.stringify({ builderId, buildId, byBuilderId, station: STATION_ID }),
      signal: AbortSignal.timeout(20_000),
    });
    const out: any = await r.json().catch(() => null);
    if (!out?.success) {
      const why = out?.error || (r.status === 404 ? "this RT-MCS has no release route yet" : `RtMcs answered HTTP ${r.status}`);
      return res.status(r.ok ? 409 : r.status).json({ success: false, error: String(why) });
    }
    res.json({ success: true, result: { action: String(out.action ?? ""), message: String(out.message ?? "") } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ success: false, error: `RtMcs unreachable at ${rtmcsUrl}: ${message}` });
  }
});

app.post("/api/set-db-path", (req, res) => {
  const incomingPath = req.body?.path;
  if (engine === "pg") {
    return res.status(400).json({
      success: false,
      error: `This station uses PostgreSQL (${pgTarget() || "db-config engine pg"}) - there is no database file to choose`,
    });
  }

  if (!incomingPath) {
    return res.status(400).json({ success: false, error: "Path is required" });
  }

  try {
    validateSQLitePath(incomingPath);
    dbPath = incomingPath;
    // The timer switches ride along: choosing a database file must not turn
    // a station's features off behind its back.
    const keep: any = {};
    try {
      const old = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
      if (old?.timer && typeof old.timer === "object") keep.timer = old.timer;
    } catch { /* no config yet */ }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ dbPath, rtmcsUrl, ...keep }, null, 2), "utf-8");
    console.log("Database path saved:", dbPath);
    void loadRtmcsKey();
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

app.post("/api/query", async (req, res) => {
  if (!dbConfigured()) {
    return res.status(400).json({ success: false, error: "Database not configured" });
  }

  const { query, params, queueable, kind } = req.body;

  if (!query) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }

  try {
    // Not the values of a statement that names a password or the RtMcs key: a
    // builder added on the settings page left theirs in server.log.
    console.log(
      query,
      /password|KEYVAL/i.test(String(query))
        ? `[${Array.isArray(params) ? params.length : 0} value(s) withheld]`
        : params
    );
    // `queueable` is the caller saying "I do not need the result of this, and
    // it is safe to apply late". Only writes whose parameters are already
    // settled qualify - a pause row, closing a segment. Anything that hands
    // back an id the page is about to use must keep failing loudly, because a
    // build id that does not exist yet cannot be written against.
    if (queueable === true) {
      const out = await runOrQueue(typeof kind === "string" && kind ? kind : "write", [
        { query, params: params ?? [] },
      ]);
      if (!out.success) return res.status(500).json({ success: false, error: out.error });
      return res.json({ success: true, result: out.result, queued: out.queued === true });
    }
    const result = await runQuery(query, params ?? []);
    if (!result.success) {
      // A batch writes its crew rows through here (timeDistribution.ts). An
      // RT-MCS that refuses the table turns them off for the session, the
      // same as a refused Start or roll does.
      noteSegCrewRefusal(result.error);
      return res.status(500).json({ success: false, error: result.error });
    }
    res.json({ success: true, result: result.result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(err);
    res.status(500).json({ success: false, error: message });
  }
});

// --------------------
// Start server
// --------------------
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log("Config file:", CONFIG_FILE);
  console.log("Worker path:", WORKER_PATH);
});

setInterval(() => {}, 1000 * 60 * 60);
