const { workerData, parentPort } = require("worker_threads");
const Database = require("better-sqlite3");

try {
    const db = new Database(workerData.dbPath, { readonly: workerData.readonly ?? false });
    db.pragma("journal_mode = WAL"); // WAL mode prevents read/write blocking

    const { query, params } = workerData;
    const stmt = db.prepare(query);

    let result;
    if (query.trim().toUpperCase().startsWith("SELECT")) {
        result = stmt.all(params);
    } else {
        const info = stmt.run(params);
        // lastID lets INSERT callers get the new row id directly instead of a
        // separate MAX() query (which races when two stations insert at once).
        result = { changes: info.changes, lastID: Number(info.lastInsertRowid) };
    }

    db.close();
    parentPort.postMessage({ success: true, result });
} catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
}
