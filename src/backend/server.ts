import express from "express";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import cors from "cors";

const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

// --------------------
// Persistent config
// --------------------
const CONFIG_FILE = path.join(process.cwd(), "db-config.json");

let dbPath: string | null = null;

// --------------------
// Helpers
// --------------------
async function validateSQLitePath(candidate: string): Promise<void> {
    const stat = fs.statSync(candidate);

    if (!stat.isFile()) {
        throw new Error("Path is not a file");
    }

    const db = await open({
        filename: candidate,
        driver: sqlite3.Database,
        mode: sqlite3.OPEN_READWRITE,
    });

    await db.close();
}

// --------------------
// SQL Controller
// --------------------
class SQLController {
    private dbPath: string | null;

    constructor(dbPath: string | null) {
        this.dbPath = dbPath;
    }

    async connectToDatabase(): Promise<Database<sqlite3.Database, sqlite3.Statement>> {
        if (!this.dbPath) {
            throw new Error("Database path not set");
        }

        return open({
            filename: this.dbPath,
            driver: sqlite3.Database,
            mode: sqlite3.OPEN_READWRITE,
        });
    }

    async exec(query: string, params: any[] = []) {
        const db = await this.connectToDatabase();
        try {
            if (query.trim().toUpperCase().startsWith("SELECT")) {
                return await db.all(query, params);
            } else {
                const result = await db.run(query, params);
                return result.changes;
            }
        } finally {
            await db.close();
        }
    }
}

// --------------------
// Load DB path on startup (VALIDATES EVERY LAUNCH)
// --------------------
(async () => {
    if (!fs.existsSync(CONFIG_FILE)) return;

    try {
        const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
        const config = JSON.parse(raw);

        if (!config.dbPath) return;

        await validateSQLitePath(config.dbPath);
        dbPath = config.dbPath;

        console.log("Loaded DB path:", dbPath);
    } catch (err) {
        console.warn("Saved DB path invalid, ignoring:", err);
        dbPath = null;
    }
})();

// --------------------
// Routes
// --------------------

app.get("/api/db-status", async (_req, res) => {
    if (!dbPath) {
        return res.json({
            ready: false,
            error: "No database path configured",
        });
    }

    try {
        await validateSQLitePath(dbPath);
        res.json({ ready: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.json({
            ready: false,
            error: message,
        });
    }
});

app.post("/api/set-db-path", async (req, res) => {
    const incomingPath = req.body?.path;

    if (!incomingPath) {
        return res.status(400).json({
            success: false,
            error: "Path is required",
        });
    }

    try {
        await validateSQLitePath(incomingPath);

        dbPath = incomingPath;

        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ dbPath }, null, 2), "utf-8");

        console.log("Database path saved:", dbPath);

        res.json({ success: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({
            success: false,
            error: message,
        });
    }
});

app.post("/api/query", async (req, res) => {
    if (!dbPath) {
        return res.status(400).json({
            success: false,
            error: "Database not configured",
        });
    }

    const { query, params } = req.body;

    if (!query) {
        return res.status(400).json({
            success: false,
            error: "Query is required",
        });
    }

    const sql = new SQLController(dbPath);

    try {
        console.log(req);
        const result = await sql.exec(query, params);
        res.json({ success: true, result });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(err);
        res.status(500).json({ success: false, error: message });
    }
});

// --------------------
// Start server
// --------------------
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
    console.log("Config file:", CONFIG_FILE);
});
