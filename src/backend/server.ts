import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import cors from "cors";
import { Worker } from "worker_threads";
import { WriteQueue } from "./writeQueue";

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
app.use(express.json());

// --------------------
// Persistent config
// --------------------
const CONFIG_FILE = process.env.DB_CONFIG_PATH ?? path.join(process.cwd(), "db-config.json");
const WORKER_PATH = process.env.WORKER_PATH ?? path.join(process.cwd(), "src/backend/db.worker.cjs");

let dbPath: string | null = null;

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
            console.log("Worker result:", JSON.stringify(msg));
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
    return /RtMcs unreachable|RtMcs key not loaded|database busy|fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|timed out|abort|readonly|unable to open|disk I[/]O|database is locked|SQLITE_(READONLY|CANTOPEN|IOERR|BUSY)|without a result envelope|HTTP 5\d\d/i.test(
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
    if (flushing || !dbPath || !rtmcsKey) return;
    flushing = true;
    try {
        for (;;) {
            const entry = writeQueue.peek();
            if (!entry) {
                lastFlushError = null;
                break;
            }
            const out = await runWorkerRemote({ dbPath, statements: entry.statements });
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
    const entry = writeQueue.add(kind, statements, nowLocal());
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
 * `ready` deliberately keeps its old meaning - configured, present and a real
 * SQLite file - because App.tsx sends the operator to the database SETUP screen
 * when it is false. A share that is merely read-only is not a reason to ask
 * anyone to re-type the path, so writability is reported separately and the
 * timer page is what acts on it.
 */
app.get("/api/db-status", async (_req, res) => {
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
    return res.json({ ready: true, writable: false, writeError: detail, journalMode: mode });
  }

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
app.post("/api/heartbeat", async (req, res) => {
  if (!dbPath) return res.status(400).json({ success: false, error: "Database not configured" });
  const { segmentId, accumSeconds, state } = req.body ?? {};
  if (!segmentId) return res.status(400).json({ success: false, error: "segmentId is required" });
  try {
    // accumSeconds only ever moves forward: a stale/duplicate heartbeat can
    // never claw back time the operator actually worked. That is also what
    // makes a heartbeat safe to queue and replay late - an old one landing
    // after a newer one changes nothing.
    const out = await runOrQueue("heartbeat", [
      {
        query: `UPDATE HARNBUILDSEGMENTS
          SET heartbeatAt = ?, heartbeatState = ?,
              accumSeconds = MAX(COALESCE(accumSeconds, 0), ?),
              stationId = COALESCE(stationId, ?)
        WHERE segmentId = ? AND COALESCE(endTime, '') = ''`,
        params: [nowLocal(), state === "PAUSE" ? "PAUSE" : "RUN", Math.max(0, Math.floor(Number(accumSeconds) || 0)), STATION_ID, segmentId],
      },
    ]);
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
  if (!dbPath) return res.status(400).json({ success: false, error: "Database not configured" });
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
 */
app.post("/api/build/start", async (req, res) => {
  if (!dbPath) return res.status(400).json({ success: false, error: "Database not configured" });
  const { harnNumber, rev, builderId, timeTypeId, numberOfBuilders, secondaryBuilderIds, startTime } = req.body ?? {};
  if (!harnNumber) return res.status(400).json({ success: false, error: "harnNumber is required" });
  const start = startTime || nowLocal();
  const builders = Math.max(1, Number(numberOfBuilders) || 1);
  try {
    const first = await mustRun([
      { query: `INSERT INTO HARNBUILDS (harnNumber) VALUES (?)`, params: [harnNumber], requireChanges: 1 },
    ]);
    const buildId = Number(first[0].lastID);
    const rest = await mustRun([
      {
        query: `INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders)
                VALUES (?, ?, ?, ?, ?, ?)`,
        params: [buildId, harnNumber, rev ?? null, builderId ?? null, timeTypeId ?? 1, builders],
        requireChanges: 1,
      },
      {
        query: `INSERT INTO HARNBUILDSEGMENTS
                  (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId)
                VALUES (?, ?, '', ?, 0, ?, 'RUN', ?, ?)`,
        params: [buildId, start, builders, start, STATION_ID, builderId ?? null],
        requireChanges: 1,
      },
      ...(Array.isArray(secondaryBuilderIds) ? secondaryBuilderIds : []).map((id: any) => ({
        query: `INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)`,
        params: [buildId, id],
      })),
    ]);
    res.json({ success: true, result: { buildId, segmentId: Number(rest[1].lastID), startTime: start } });
  } catch (err) {
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
  if (!dbPath) return res.status(400).json({ success: false, error: "Database not configured" });
  const { buildId, segmentId, accumSeconds, numberOfBuilders, secondaryBuilderIds, builderId } =
    req.body ?? {};
  if (!buildId || !segmentId) {
    return res.status(400).json({ success: false, error: "buildId and segmentId are required" });
  }
  const now = nowLocal();
  const builders = Math.max(1, Number(numberOfBuilders) || 1);
  // A handover names the incoming builder; a plain crew change does not, and
  // must leave both the build row and the new segment on whoever is already
  // recorded - never NULL them.
  const newPrimary = Number(builderId) > 0 ? Number(builderId) : null;
  try {
    const out = await mustRun([
      {
        query: `UPDATE HARNBUILDSEGMENTS
                   SET endTime = ?, accumSeconds = MAX(COALESCE(accumSeconds, 0), ?), heartbeatAt = ?
                 WHERE segmentId = ? AND COALESCE(endTime, '') = '' AND stationId = ?`,
        params: [now, Math.max(0, Math.floor(Number(accumSeconds) || 0)), now, segmentId, STATION_ID],
        requireChanges: 1,
      },
      {
        // COALESCE, not the raw value: on a plain crew change newPrimary is
        // null and the new segment inherits the builder the build already has.
        query: `INSERT INTO HARNBUILDSEGMENTS
                  (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId)
                VALUES (?, ?, '', ?, 0, ?, 'RUN', ?,
                        COALESCE(?, (SELECT t.builderId FROM HARNBUILDTIMES t
                                      WHERE t.buildId = ? AND t.timeTypeId <> 4
                                      ORDER BY t.harnBuildTimeId LIMIT 1)))`,
        params: [buildId, now, builders, now, STATION_ID, newPrimary, buildId],
        requireChanges: 1,
      },
      {
        query: `UPDATE HARNBUILDTIMES
                   SET numberOfBuilders = ?, builderId = COALESCE(?, builderId)
                 WHERE buildId = ? AND timeTypeId <> 4`,
        params: [builders, newPrimary, buildId],
      },
      { query: `DELETE FROM SECONDARYBUILDERS WHERE buildId = ?`, params: [buildId] },
      ...(Array.isArray(secondaryBuilderIds) ? secondaryBuilderIds : []).map((id: any) => ({
        query: `INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)`,
        params: [buildId, id],
      })),
    ]);
    res.json({ success: true, result: { segmentId: Number(out[1].lastID), startTime: now } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * Drop a build that is still LIVE on this station - the single-build rows
 * written at Start - because the operator switched it to a batch mid-run and
 * Submit is about to write the batch's units instead. Hands back the build's
 * pause rows so the batch can carry them. One transaction, and the guard on the
 * HARNBUILDS delete (an OPEN segment on this station) means a build that was
 * already submitted, or belongs to another station, can never be discarded.
 */
app.post("/api/build/discard", async (req, res) => {
  if (!dbPath) return res.status(400).json({ success: false, error: "Database not configured" });
  const buildId = Number(req.body?.buildId);
  if (!buildId) return res.status(400).json({ success: false, error: "buildId is required" });
  try {
    const out = await mustRun([
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
      { query: `DELETE FROM HARNBUILDSEGMENTS WHERE buildId = ?`, params: [buildId] },
      { query: `DELETE FROM SECONDARYBUILDERS WHERE buildId = ?`, params: [buildId] },
      { query: `DELETE FROM HARNBUILDTIMES WHERE buildId = ?`, params: [buildId] },
    ]);
    res.json({ success: true, result: { pauses: Array.isArray(out[0]) ? out[0] : [] } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

app.post("/api/set-db-path", (req, res) => {
  const incomingPath = req.body?.path;

  if (!incomingPath) {
    return res.status(400).json({ success: false, error: "Path is required" });
  }

  try {
    validateSQLitePath(incomingPath);
    dbPath = incomingPath;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ dbPath, rtmcsUrl }, null, 2), "utf-8");
    console.log("Database path saved:", dbPath);
    void loadRtmcsKey();
    res.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(400).json({ success: false, error: message });
  }
});

app.post("/api/query", async (req, res) => {
  if (!dbPath) {
    return res.status(400).json({ success: false, error: "Database not configured" });
  }

  const { query, params, queueable, kind } = req.body;

  if (!query) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }

  try {
    console.log(query, params);
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
