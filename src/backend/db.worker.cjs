const { workerData, parentPort } = require("worker_threads");

console.log("Worker started");
console.log("BETTER_SQLITE3_PATH:", process.env.BETTER_SQLITE3_PATH);
console.log("dbPath:", workerData.dbPath);
console.log("query:", workerData.query);

try {
    console.log("Loading better-sqlite3...");
    const Database = require(process.env.BETTER_SQLITE3_PATH || 'better-sqlite3');
    console.log("Loaded better-sqlite3, opening DB...");
    
    const db = new Database(workerData.dbPath, { readonly: workerData.readonly ?? false });
    console.log("DB opened successfully");
    
    console.log("WAL mode set");

    const { query, params } = workerData;
    const stmt = db.prepare(query);
    console.log("Statement prepared");

    let result;
    if (query.trim().toUpperCase().startsWith("SELECT")) {
        result = stmt.all(params);
    } else {
        const info = stmt.run(params);
        result = info.changes;
    }

    console.log("Query executed successfully");
    db.close();
    parentPort.postMessage({ success: true, result });
} catch (err) {
    console.log("Worker error:", err.message);
    parentPort.postMessage({ success: false, error: err.message });
}