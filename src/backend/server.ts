import express from "express";
import fs from "fs";
import path from "path";
import cors from "cors";
import { Worker } from "worker_threads";

const app = express();
const port = 5000;

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
function runQuery(query: string, params: any[] = []): Promise<any> {
    return new Promise((resolve, reject) => {
      console.log("Worker path exists:", fs.existsSync(WORKER_PATH), WORKER_PATH);
        const worker = new Worker(WORKER_PATH, {
            workerData: { dbPath, query, params },
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

    // Recreate (not IF NOT EXISTS) so an old definition in the DB gets
    // replaced. The old h.* + aliased-aggregate shape looked right but never
    // worked: better-sqlite3 does NOT merge duplicate column names - it
    // suffixes the later ones (":1"), so consumers read h's always-NULL
    // startTime/endTime and every chart duration came out 0. Explicit columns
    // give the aggregate the real names, and GROUP BY harnBuildTimeId (the
    // row id) keeps pause rows (same buildId, timeTypeId 4) from collapsing
    // into their build row and randomly hijacking its timeTypeId.
    await runQuery(`DROP VIEW IF EXISTS HARNBUILDTIMES_VIEW`)
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
          MAX(s.endTime) as endTime
      FROM HARNBUILDTIMES h
      LEFT JOIN HARNBUILDSEGMENTS s ON h.buildId = s.buildId
      GROUP BY h.harnBuildTimeId
    `)
  } catch (err) {
    console.warn("Saved DB path invalid, ignoring:", err);
    dbPath = null;
  }
})();

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