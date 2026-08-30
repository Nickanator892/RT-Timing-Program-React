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

// --------------------
// Worker thread runner
// --------------------
function runWorker(workerPayload: any): Promise<any> {
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
    console.log("Loaded DB path:", dbPath);

    await migrate();
  } catch (err) {
    console.warn("Saved DB path invalid, ignoring:", err);
    dbPath = null;
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
  // -- HBTV v3 (keep byte-identical with the copy in HPP's
  //             BuildTimerScheduleForm.EnsureTimingTables; bump both together)
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

app.get("/api/db-status", (_req, res) => {
  console.log("DBPATH", dbPath)
  if (!dbPath) {
    return res.json({ ready: false, error: "No database path configured" });
  }
  try {
    validateSQLitePath(dbPath);
    res.json({ ready: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.json({ ready: false, error: message });
  }
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

app.post("/api/set-db-path", (req, res) => {
  const incomingPath = req.body?.path;

  if (!incomingPath) {
    return res.status(400).json({ success: false, error: "Path is required" });
  }

  try {
    validateSQLitePath(incomingPath);
    dbPath = incomingPath;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ dbPath }, null, 2), "utf-8");
    console.log("Database path saved:", dbPath);
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