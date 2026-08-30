const { workerData, parentPort } = require("worker_threads");

console.log("Worker started");
console.log("BETTER_SQLITE3_PATH:", process.env.BETTER_SQLITE3_PATH);
console.log("dbPath:", workerData.dbPath);

function runOne(db, query, params) {
    const stmt = db.prepare(query);
    if (query.trim().toUpperCase().startsWith("SELECT")) {
        return stmt.all(params ?? []);
    }
    const info = stmt.run(params ?? []);
    // lastID lets INSERT callers get the new row id directly instead of a
    // separate MAX() query (which races when two stations insert at once).
    return { changes: info.changes, lastID: Number(info.lastInsertRowid) };
}

try {
    console.log("Loading better-sqlite3...");
    const Database = require(process.env.BETTER_SQLITE3_PATH || 'better-sqlite3');
    console.log("Loaded better-sqlite3, opening DB...");

    const db = new Database(workerData.dbPath, { readonly: workerData.readonly ?? false });
    console.log("DB opened successfully");

    // The database lives on a network share and is shared with the pricing
    // program, so a writer can legitimately be mid-commit when we arrive.
    try { db.pragma("busy_timeout = 5000"); } catch {}

    let result;
    if (Array.isArray(workerData.statements)) {
        // Multi-statement transaction: recovery must close a dead segment and
        // open its replacement atomically. Between those two statements a
        // build has NO open segment, and RtMcs's timer sweep reads that as
        // "submitted" and proposes consuming inventory for it.
        // A statement may declare requireChanges; violating it throws, which
        // rolls the whole transaction back.
        console.log("transaction of", workerData.statements.length, "statements");
        const results = [];
        db.transaction(() => {
            for (const s of workerData.statements) {
                const r = runOne(db, s.query, s.params);
                if (
                    typeof s.requireChanges === "number" &&
                    (!r || r.changes !== s.requireChanges)
                ) {
                    throw new Error(
                        `Expected ${s.requireChanges} row(s) changed but got ${r && r.changes} - ` +
                        `rolling back (the row was already handled elsewhere)`
                    );
                }
                results.push(r);
            }
        })();
        result = results;
    } else {
        console.log("query:", workerData.query);
        result = runOne(db, workerData.query, workerData.params);
    }

    console.log("Query executed successfully");
    db.close();
    console.log("DB closed");
    parentPort.postMessage({ success: true, result });
    console.log("Message posted");
} catch (err) {
    console.log("Worker error:", err.message);
    parentPort.postMessage({ success: false, error: err.message });
}
