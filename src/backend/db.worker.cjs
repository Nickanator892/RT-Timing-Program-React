const { workerData, parentPort } = require("worker_threads");
console.log("Worker started");
console.log("BETTER_SQLITE3_PATH:", process.env.BETTER_SQLITE3_PATH);
console.log("dbPath:", workerData.dbPath);

const Database = require(process.env.BETTER_SQLITE3_PATH || 'better-sqlite3');

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
        result = info.changes;
    }

    db.close();
    parentPort.postMessage({ success: true, result });
} catch (err) {
    parentPort.postMessage({ success: false, error: err.message });
}
