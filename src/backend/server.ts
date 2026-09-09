import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import cors from "cors";
import { Worker } from "worker_threads";

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
/** Local better-sqlite3 worker - reads only, now that writes are proxied. */
function runWorkerLocal(workerPayload: any): Promise<any> {
    return new Promise((resolve, reject) => {
      console.log("Worker path exists:", fs.existsSync(WORKER_PATH), WORKER_PATH);
        const worker = new Worker(WORKER_PATH, {
            workerData: { dbPath, ...workerPayload },
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

/** Reads run in the local worker; every write goes through RtMcs. */
function runWorker(workerPayload: any): Promise<any> {
    return isWrite(workerPayload) ? runWorkerRemote(workerPayload) : runWorkerLocal(workerPayload);
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
  res.json({ ready: true, writable: remote.writable, writeError: remote.writeError, writer: rtmcsUrl });
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
    // never claw back time the operator actually worked.
    const out = await runQuery(
      `UPDATE HARNBUILDSEGMENTS
          SET heartbeatAt = ?, heartbeatState = ?,
              accumSeconds = MAX(COALESCE(accumSeconds, 0), ?),
              stationId = COALESCE(stationId, ?)
        WHERE segmentId = ? AND COALESCE(endTime, '') = ''`,
      [nowLocal(), state === "PAUSE" ? "PAUSE" : "RUN", Math.max(0, Math.floor(Number(accumSeconds) || 0)), STATION_ID, segmentId]
    );
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
                  (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId)
                VALUES (?, ?, '', ?, 0, ?, 'RUN', ?)`,
        params: [buildId, start, builders, start, STATION_ID],
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
 */
app.post("/api/build/segment-roll", async (req, res) => {
  if (!dbPath) return res.status(400).json({ success: false, error: "Database not configured" });
  const { buildId, segmentId, accumSeconds, numberOfBuilders, secondaryBuilderIds } = req.body ?? {};
  if (!buildId || !segmentId) {
    return res.status(400).json({ success: false, error: "buildId and segmentId are required" });
  }
  const now = nowLocal();
  const builders = Math.max(1, Number(numberOfBuilders) || 1);
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
        query: `INSERT INTO HARNBUILDSEGMENTS
                  (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId)
                VALUES (?, ?, '', ?, 0, ?, 'RUN', ?)`,
        params: [buildId, now, builders, now, STATION_ID],
        requireChanges: 1,
      },
      { query: `UPDATE HARNBUILDTIMES SET numberOfBuilders = ? WHERE buildId = ?`, params: [builders, buildId] },
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

  const { query, params } = req.body;

  if (!query) {
    return res.status(400).json({ success: false, error: "Query is required" });
  }

  try {
    console.log(query, params);
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