// PostgreSQL port, against a bench clone and a SQLite copy of the same data.
//
//   PG_BENCH_CONFIG=<db-config.json for the clone>  (engine "pg", user timing_app, a passwordFile)
//   SQLITE_SCRATCH=<the SQLite file the clone was loaded from>
//   npx tsx --test --test-concurrency=1 tests/pg/bench.test.ts
//
// 1. every read the app sends (catalog.ts) gives the same rows on both engines;
// 2. one shop scenario (start, heartbeat, pause, crew roll, close, batch of 3,
//    discard, bobbin) driven through the real server on each engine writes the
//    same rows - SQLite through a stand-in RT-MCS running the worker's
//    semantics on a scratch copy, so the unchanged path is exercised too;
// 3. concurrency on PostgreSQL: consecutive ids per batch under a competing
//    writer, the ONE PLACE savepoint, lock_timeout + one retry, and the
//    schema-stamp fail-closed.
// Skips unless both variables are set. Never runs against anything but whpp_bench_*.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import pg from "pg";
import {
    benchEnv, sqliteCopy, compareRows, fakeRtMcs, startServer, api, nowLocal, type RowDiff,
} from "./harness.ts";
import { CATALOG, type Samples } from "./catalog.ts";
import {
    openPool, closePool, checkSchemaStamp, pgRunPayload, pgWithWriteTx, REQUIRED_SCHEMA, WRITE_LOCK_KEY,
    readSecretFile, type PgConfig,
} from "../../src/backend/pgEngine.ts";
import { setDbEngine, sqlFor } from "../../src/assets/dbEngine.ts";
import { writeDistributedTimes } from "../../src/assets/timeDistribution.ts";

const env = benchEnv();
const skip = env ? false : "PG_BENCH_CONFIG and SQLITE_SCRATCH not set";
// SQLITE_SCRATCH alone runs the SQLite half: the unchanged path, end to end.
const liteSource = process.env.SQLITE_SCRATCH;
const skipLite = liteSource ? false : "SQLITE_SCRATCH not set";
const STATION = os.hostname();
const FAKE_RTMCS_PORT = 8399;

let lite: Database.Database;
let samples: Samples;

function rawClient(cfg: PgConfig): pg.Client {
    return new pg.Client({
        host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user,
        password: readSecretFile(cfg.passwordFile, "PostgreSQL password"), application_name: "rt-timing-test",
    });
}

before(async () => {
    if (!liteSource) return;
    lite = new Database(sqliteCopy(liteSource, "read"), { readonly: true });
    samples = pickSamples(lite);
    console.log("samples:", JSON.stringify(samples));
    if (!env) return;
    openPool(env.pgConfig, { lockTimeoutMs: 1_000, busyRetryDelayMs: 500 });
    const blocked = await checkSchemaStamp();
    assert.equal(blocked, null, `clone refused: ${blocked}`);
});

after(async () => {
    lite?.close();
    await closePool();
});

/** Real rows from the snapshot, so every query has something to find. */
function pickSamples(db: Database.Database): Samples {
    const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as any;
    const open = new Set(
        (db.prepare(`SELECT DISTINCT builderId FROM HARNBUILDSEGMENTS WHERE COALESCE(endTime,'') = '' AND builderId IS NOT NULL`).all() as any[])
            .map((r) => Number(r.builderId))
    );
    const idle = (db.prepare(`SELECT Id FROM HARNBUILDERS WHERE active != 0 ORDER BY Id`).all() as any[])
        .map((r) => Number(r.Id)).filter((id) => !open.has(id));
    const seg = one(`SELECT s.buildId, s.segmentId FROM HARNBUILDSEGMENTS s
                      JOIN HARNBUILDTIMES h ON h.buildId = s.buildId AND h.timeTypeId <> 4
                     WHERE COALESCE(s.endTime,'') <> '' ORDER BY s.segmentId DESC LIMIT 1`);
    const t = one(`SELECT harnNumber, REV, timeTypeId FROM HARNBUILDTIMES WHERE buildId = ? AND timeTypeId <> 4`, seg.buildId);
    const kit = one(`SELECT PHKID FROM BUILDKITLIST WHERE REV = ? LIMIT 1`, t.REV);
    const ms = one(`SELECT MSID FROM MSSCHED_VIEW WHERE REV IS NOT NULL ORDER BY MSID LIMIT 1`);
    const rel = one(`SELECT AT FROM MSTIMERRELEASE ORDER BY ID DESC LIMIT 1`);
    return {
        builderId: idle[0], buildId: Number(seg.buildId), segmentId: Number(seg.segmentId),
        harnNumber: String(t.harnNumber), rev: Number(t.REV), phkid: kit ? Number(kit.PHKID) : null,
        timeTypeId: Number(t.timeTypeId), station: STATION, reasonName: "Clocked out (QuickBooks)",
        now: nowLocal(), msid: ms ? Number(ms.MSID) : 0, handoffKinds: ["OFFER_TIMING_PN", "OFFER_TIMING"],
        builderIds: idle.slice(0, 3), closedAt: rel?.AT ?? nowLocal(),
    };
}

function report(id: string, d: RowDiff): string {
    return `${id}: ${JSON.stringify(d, null, 1).slice(0, 1500)}`;
}

// --------------------
// 1. Reads, row for row
// --------------------
test("every read gives the same rows on both engines", { skip }, async () => {
    const failures: string[] = [];
    const typeNotes: string[] = [];
    // server.ts sends these two on SQLite only (pg returns before them).
    const sqliteOnly = new Set(["srv-msapikey", "srv-segcrew-exists"]);
    for (const q of CATALOG) {
        if (sqliteOnly.has(q.id)) continue;
        const params = q.params(samples);
        let liteRows: any[];
        try {
            liteRows = lite.prepare(q.sqlite).all(...(params as any[])) as any[];
        } catch (err: any) {
            failures.push(`${q.id}: SQLite failed: ${err.message}`);
            continue;
        }
        const out = await pgRunPayload({ query: q.pg, params });
        if (!out.success) {
            failures.push(`${q.id} (${q.source}): PostgreSQL failed: ${out.error}`);
            continue;
        }
        const d = compareRows(liteRows, out.result, q.ordered);
        if (!d) continue;
        const onlyTypes = !d.keysSqlite && d.countSqlite == null && d.cells.every((c) => c.typeOnly);
        (onlyTypes ? typeNotes : failures).push(report(q.id, d));
    }
    if (typeNotes.length) console.log(`number-vs-text differences (values equal):\n${typeNotes.join("\n")}`);
    console.log(`${CATALOG.length} reads compared, ${failures.length} differ`);
    assert.deepEqual(failures, []);
});

// --------------------
// 2. One shop scenario on each engine
// --------------------
interface ScenarioResult { rows: Record<string, any[]>; batchIds: number[] }

async function scenario(engine: "sqlite" | "pg", t0: string): Promise<ScenarioResult> {
    setDbEngine(engine);
    const s = samples;
    const [b1, b2] = s.builderIds;
    const q = async (query: string, params: unknown[], queueable = false) => {
        const r = await api("/api/query", { query, params, ...(queueable ? { queueable: true, kind: "test" } : {}) });
        assert.equal(r.success, true, `${query}: ${r.error}`);
        return r.result;
    };
    const reasons = await q("SELECT * FROM HARNBUILDPAUSEREASONS WHERE active = 1", []);
    const reasonId = Number(reasons[0].Id);
    assert.ok(reasonId > 0, "pause reasons keep their Id key");

    const start = await api("/api/build/start", {
        harnNumber: s.harnNumber, rev: s.rev, builderId: b1, timeTypeId: 1, secondaryBuilderIds: [b2], startTime: t0,
    });
    assert.equal(start.success, true, start.error);
    const buildId = start.result.buildId;
    let segmentId = start.result.segmentId;

    const hb = await api("/api/heartbeat", { segmentId, accumSeconds: 30, state: "RUN" });
    assert.equal(hb.success, true, hb.error);
    assert.equal(hb.result[0].changes, 1);

    await q(
        "INSERT INTO HARNBUILDTIMES (buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        [buildId, t0, t0, s.harnNumber, s.rev, b1, 4, reasonId], true
    );

    // Bobbin change, as timingPage writes it.
    await q(
        `INSERT INTO MSTIMERBOBBIN (HARN, REV, BUILDID, BUILDERID, STATION, STARTTIME, ENDTIME)
                 SELECT ${sqlFor("?, ?, ?, ?", "?::text, ?::integer, ?::integer, ?::integer")}, stationId, ${sqlFor("?", "?::text")}, '' FROM HARNBUILDSEGMENTS WHERE segmentId = ?`,
        [s.harnNumber, s.rev, buildId, b1, t0, segmentId]
    );
    await q(
        `UPDATE MSTIMERBOBBIN
                    SET ENDTIME = ?, SECONDS = ${sqlFor(
                        "MAX(0, CAST(strftime('%s', ?) AS INTEGER) - CAST(strftime('%s', STARTTIME) AS INTEGER))",
                        "GREATEST(0, CAST(EXTRACT(EPOCH FROM CAST(? AS timestamp) - CAST(STARTTIME AS timestamp)) AS integer))"
                    )}
                  WHERE BUILDERID = ? AND ENDTIME = ''`,
        ["2000-01-01 00:01:40".replace("2000-01-01", t0.slice(0, 10)), "2000-01-01 00:01:40".replace("2000-01-01", t0.slice(0, 10)), b1],
        true
    );

    const roll = await api("/api/build/segment-roll", { buildId, segmentId, accumSeconds: 60, secondaryBuilderIds: [] });
    assert.equal(roll.success, true, roll.error);
    segmentId = roll.result.segmentId;

    const closed = await q(
        `UPDATE HARNBUILDSEGMENTS
                SET endTime = ?, accumSeconds = ?, heartbeatAt = ?, heartbeatState = 'PAUSE'
              WHERE segmentId = ? AND COALESCE(endTime, '') = ''`,
        [t0, 90, t0, segmentId], true
    );
    // A queueable write runs as a one-statement transaction: [{ changes }].
    assert.equal(closed[0].changes, 1);

    // A batch of 3, the last one an extra unit, two people on it.
    const startMs = new Date(t0.replace(" ", "T")).getTime();
    const batchIds = await writeDistributedTimes({
        harnNumber: s.harnNumber, rev: s.rev, builderId: b1, timeTypeId: 1, units: 3,
        startMs, endMs: startMs + 3_600_000, workedMs: 3_000_000, numberOfBuilders: 2, secondaryBuilderIds: [b2],
        unitDecision: "EXTRA", excessUnits: 1, writeSegCrew: true,
    });
    assert.equal(batchIds.length, 3);
    assert.deepEqual(batchIds, [batchIds[0], batchIds[0] + 1, batchIds[0] + 2], "a batch's build ids are consecutive");

    // Start one more and throw it away.
    const doomed = await api("/api/build/start", { harnNumber: s.harnNumber, rev: s.rev, builderId: b1, timeTypeId: 1, startTime: t0 });
    assert.equal(doomed.success, true, doomed.error);
    const discard = await api("/api/build/discard", { buildId: doomed.result.buildId });
    assert.equal(discard.success, true, discard.error);
    assert.equal(discard.result.segments.length, 1);

    const ids = [buildId, ...batchIds, doomed.result.buildId];
    const marks = ids.map(() => "?").join(",");
    const rows: Record<string, any[]> = {};
    for (const [name, sql] of Object.entries({
        builds: `SELECT buildId, harnNumber FROM HARNBUILDS WHERE buildId IN (${marks}) ORDER BY buildId`,
        times: `SELECT buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId, numberOfBuilders, unitDecision FROM HARNBUILDTIMES WHERE buildId IN (${marks}) ORDER BY harnBuildTimeId`,
        segments: `SELECT buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId FROM HARNBUILDSEGMENTS WHERE buildId IN (${marks}) ORDER BY segmentId`,
        secondary: `SELECT buildId, builderId FROM SECONDARYBUILDERS WHERE buildId IN (${marks}) ORDER BY secondaryBuilderId`,
        crew: `SELECT buildId, builderId FROM HARNBUILDSEGCREW WHERE buildId IN (${marks}) ORDER BY segmentId, builderId`,
        bobbin: `SELECT HARN, REV, BUILDID, BUILDERID, STATION, STARTTIME, ENDTIME, SECONDS FROM MSTIMERBOBBIN WHERE BUILDID IN (${marks}) ORDER BY ID`,
        view: `SELECT * FROM HARNBUILDTIMES_VIEW WHERE buildId IN (${marks}) ORDER BY harnBuildTimeId`,
    })) {
        rows[name] = await q(sql, ids);
    }
    // Ids differ between the databases; their order does not.
    const order = new Map(ids.map((id, i) => [Number(id), i]));
    for (const list of Object.values(rows)) {
        for (const r of list) {
            for (const k of Object.keys(r)) {
                if (/^(buildId|BUILDID)$/.test(k)) r[k] = `#${order.get(Number(r[k])) ?? r[k]}`;
                else if (k === "harnBuildTimeId") r[k] = "<row id>"; // rows are compared in id order already
            }
        }
    }
    if (engine === "pg") {
        // Leave the clone as it was.
        const del = (table: string, col = "buildId") => ({ query: `DELETE FROM ${table} WHERE ${col} IN (${marks})`, params: ids });
        const out = await pgRunPayload({
            statements: [del("HARNBUILDSEGCREW"), del("SECONDARYBUILDERS"), del("HARNBUILDTIMES"), del("HARNBUILDSEGMENTS"), del("MSTIMERBOBBIN", "BUILDID"), del("HARNBUILDS")],
        });
        assert.equal(out.success, true, out.error);
    }
    return { rows, batchIds };
}

/** Server-stamped "now" values differ run to run; everything from t0's day on is "now". */
function maskNow(rows: Record<string, any[]>, runStart: string): Record<string, any[]> {
    const out: Record<string, any[]> = {};
    for (const [k, list] of Object.entries(rows)) {
        out[k] = list.map((r) =>
            Object.fromEntries(Object.entries(r).map(([c, v]) => [c, typeof v === "string" && v >= runStart ? "<now>" : v]))
        );
    }
    return out;
}

test("the same shop scenario writes the same rows on both engines", { skip }, async () => {
    const t0 = "2001-02-03 04:05:06"; // fixed client-side stamps; the server's own are masked
    const runStart = nowLocal();

    const copy = sqliteCopy(env!.sqliteSource, "write");
    const seed = new Database(copy);
    // The sanitized snapshot blanks the key; the stand-in RT-MCS accepts any.
    seed.prepare("UPDATE MSAPIKEY SET KEYVAL = 'scratch-only' WHERE KEYNAME = 'HPP' AND COALESCE(KEYVAL, '') = ''").run();
    if (!seed.prepare("SELECT 1 FROM MSAPIKEY WHERE KEYNAME = 'HPP'").get()) {
        seed.prepare("INSERT INTO MSAPIKEY (KEYNAME, KEYVAL) VALUES ('HPP', 'scratch-only')").run();
    }
    seed.close();
    const fake = await fakeRtMcs(copy, FAKE_RTMCS_PORT);
    let liteRun: ScenarioResult;
    let server = await startServer({ dbPath: copy, rtmcsUrl: `http://localhost:${FAKE_RTMCS_PORT}` }, "sqlite");
    try {
        liteRun = await scenario("sqlite", t0);
    } finally {
        await server.stop();
        await new Promise((r) => fake.close(r));
    }

    server = await startServer(env!.rawConfig, "pg");
    let pgRun: ScenarioResult;
    try {
        pgRun = await scenario("pg", t0);
    } finally {
        await server.stop();
    }

    const a = maskNow(liteRun.rows, runStart);
    const b = maskNow(pgRun.rows, runStart);
    const diffs: string[] = [];
    for (const table of Object.keys(a)) {
        const d = compareRows(a[table], b[table], true);
        if (d && (d.keysSqlite || d.countSqlite != null || d.cells.some((c) => !c.typeOnly))) diffs.push(report(table, d));
    }
    assert.deepEqual(diffs, []);
});

test("SQLite: every catalogued read runs", { skip: skipLite }, () => {
    const failures: string[] = [];
    for (const q of CATALOG) {
        try {
            lite.prepare(q.sqlite).all(...(q.params(samples) as any[]));
        } catch (err: any) {
            failures.push(`${q.id}: ${err.message}`);
        }
    }
    assert.deepEqual(failures, []);
});

test("SQLite: the shop scenario runs end to end through the unchanged path", { skip: skipLite }, async () => {
    const copy = sqliteCopy(liteSource!, "lite-only");
    const seed = new Database(copy);
    // The sanitized snapshot blanks the key; the stand-in RT-MCS accepts any.
    seed.prepare("UPDATE MSAPIKEY SET KEYVAL = 'scratch-only' WHERE KEYNAME = 'HPP' AND COALESCE(KEYVAL, '') = ''").run();
    if (!seed.prepare("SELECT 1 FROM MSAPIKEY WHERE KEYNAME = 'HPP'").get()) {
        seed.prepare("INSERT INTO MSAPIKEY (KEYNAME, KEYVAL) VALUES ('HPP', 'scratch-only')").run();
    }
    seed.close();
    const fake = await fakeRtMcs(copy, FAKE_RTMCS_PORT);
    const server = await startServer({ dbPath: copy, rtmcsUrl: `http://localhost:${FAKE_RTMCS_PORT}` }, "lite-only");
    try {
        const r = await scenario("sqlite", "2001-02-03 04:05:06");
        assert.equal(r.rows.builds.length, 4, "start + batch of 3 kept, the discarded build gone");
    } finally {
        await server.stop();
        await new Promise((res) => fake.close(res));
    }
});

// --------------------
// 3. Concurrency on PostgreSQL
// --------------------
test("two batches under a competing writer each get consecutive build ids", { skip }, async () => {
    const server = await startServer(env!.rawConfig, "batch");
    const created: number[] = [];
    try {
        // RT-MCS stand-in: single HARNBUILDS inserts under the same lock, flat out.
        let stop = false;
        const rival = (async () => {
            while (!stop) {
                await pgWithWriteTx(async (run) => {
                    created.push((await run({ query: "INSERT INTO HARNBUILDS (harnNumber) VALUES (?)", params: ["PG-PORT-RIVAL"] })).lastID);
                });
            }
        })();
        const unit = (k: number) => ({
            builderId: samples.builderIds[0], numberOfBuilders: 1, unitDecision: null, secondaryIds: [],
            segments: [{ startTime: `2001-02-03 05:0${k}:00`, endTime: `2001-02-03 05:0${k}:30`, numberOfBuilders: 1, accumSeconds: 30, builderId: samples.builderIds[0], crewIds: [] }],
        });
        const batch = () => api("/api/build/batch", {
            harnNumber: samples.harnNumber, rev: samples.rev, timeTypeId: 1, writeSegCrew: false, units: [0, 1, 2, 3, 4].map(unit),
        });
        const results = await Promise.all([batch(), batch(), batch()]);
        stop = true;
        await rival;
        for (const r of results) {
            assert.equal(r.success, true, r.error);
            const ids: number[] = r.result.buildIds;
            created.push(...ids);
            assert.deepEqual(ids, ids.map((_, i) => ids[0] + i), `consecutive: ${ids}`);
        }
        console.log(`rival wrote ${created.length - 15} builds in between`);
    } finally {
        await server.stop();
        const marks = created.map(() => "?").join(",") || "0";
        await pgRunPayload({
            statements: ["HARNBUILDSEGMENTS", "HARNBUILDTIMES", "HARNBUILDS"].map((t) => ({ query: `DELETE FROM ${t} WHERE buildId IN (${marks})`, params: created })),
        });
    }
});

/** An open build for `builderId` on a station that is not this one. */
async function openElsewhere(builderId: number, station: string): Promise<number> {
    return pgWithWriteTx(async (run) => {
        const b = (await run({ query: "INSERT INTO HARNBUILDS (harnNumber) VALUES (?)", params: ["PG-PORT-ONEPLACE"] })).lastID;
        await run({
            query: "INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders) VALUES (?, ?, ?, ?, ?, ?)",
            params: [b, "PG-PORT-ONEPLACE", samples.rev, builderId, 1, 1],
        });
        await run({
            query: `INSERT INTO HARNBUILDSEGMENTS (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId)
                    VALUES (?, ?, '', 1, 0, ?, 'RUN', ?, ?)`,
            params: [b, nowLocal(), nowLocal(), station, builderId],
        });
        return b;
    });
}

async function dropBuilds(ids: number[]) {
    const marks = ids.map(() => "?").join(",");
    await pgRunPayload({
        statements: ["HARNBUILDSEGCREW", "SECONDARYBUILDERS", "HARNBUILDSEGMENTS", "HARNBUILDTIMES", "HARNBUILDS"].map((t) => ({
            query: `DELETE FROM ${t} WHERE buildId IN (${marks})`, params: ids,
        })),
    });
}

test("a ONE PLACE refusal is caught by its savepoint and leaves the transaction usable", { skip }, async () => {
    const who = samples.builderIds[2];
    const blocker = await openElsewhere(who, "PG-PORT-TEST-A");
    const made: number[] = [blocker];
    try {
        let refusal = "";
        const kept = await pgWithWriteTx(async (run) => {
            const b = (await run({ query: "INSERT INTO HARNBUILDS (harnNumber) VALUES (?)", params: ["PG-PORT-ONEPLACE"] })).lastID;
            made.push(b);
            try {
                await run({
                    query: `INSERT INTO HARNBUILDSEGMENTS (buildId, startTime, endTime, numberOfBuilders, accumSeconds, heartbeatAt, heartbeatState, stationId, builderId)
                            VALUES (?, ?, '', 1, 0, ?, 'RUN', ?, ?)`,
                    params: [b, nowLocal(), nowLocal(), "PG-PORT-TEST-B", who],
                });
            } catch (err: any) {
                refusal = `${err.code} ${err.message}`;
            }
            // Without the savepoint this would be 25P02 (transaction aborted).
            await run({ query: "UPDATE HARNBUILDS SET harnNumber = ? WHERE buildId = ?", params: ["PG-PORT-ONEPLACE-KEPT", b] });
            return b;
        });
        assert.match(refusal, /^P0001 ONE PLACE AT A TIME: this builder already has a build open/);
        const back = await pgRunPayload({ query: "SELECT harnNumber FROM HARNBUILDS WHERE buildId = ?", params: [kept] });
        assert.deepEqual(back.result, [{ harnNumber: "PG-PORT-ONEPLACE-KEPT" }]);

        // Through the server: a Start for that builder here is refused whole,
        // with the text the panel's release offer looks for.
        const server = await startServer(env!.rawConfig, "oneplace");
        try {
            const r = await api("/api/build/start", { harnNumber: samples.harnNumber, rev: samples.rev, builderId: who, timeTypeId: 1 });
            assert.equal(r.success, false);
            assert.match(r.error, /ONE PLACE AT A TIME/);
            // Crew trigger: someone else starts with `who` as crew.
            const c = await api("/api/build/start", {
                harnNumber: samples.harnNumber, rev: samples.rev, builderId: samples.builderIds[1], timeTypeId: 1, secondaryBuilderIds: [who],
            });
            assert.equal(c.success, false);
            assert.match(c.error, /ONE PLACE AT A TIME: a crew member/);
            const orphans = await pgRunPayload({ query: "SELECT COUNT(*) AS n FROM HARNBUILDSEGMENTS WHERE stationId = ? AND COALESCE(endTime,'') = ''", params: [STATION] });
            assert.equal(orphans.result[0].n, 0, "a refused Start leaves nothing behind");
        } finally {
            await server.stop();
        }
    } finally {
        await dropBuilds(made);
    }
});

test("a lock wait times out at lock_timeout, is retried once, then reported busy", { skip }, async () => {
    // A second session holds RT-MCS's lock, as an RT-MCS write would.
    const holder = rawClient(env!.pgConfig);
    await holder.connect();
    const write = () => pgWithWriteTx(async (run) => run({ query: "UPDATE HARNBUILDS SET harnNumber = harnNumber WHERE buildId = ?", params: [samples.buildId] }));
    try {
        // Held longer than timeout + retry + timeout (1 s + 0.5 s + 1 s): busy.
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1)", [WRITE_LOCK_KEY]);
        let t = Date.now();
        await assert.rejects(write(), /^Error: database busy - nothing was saved \(55P03/);
        const waited = Date.now() - t;
        assert.ok(waited >= 2_400 && waited < 6_000, `waited ${waited} ms`);
        // Released during the retry pause: the retry gets through.
        t = Date.now();
        setTimeout(() => void holder.query("COMMIT"), 1_200);
        const r = await write();
        assert.equal(r.changes, 1);
        assert.ok(Date.now() - t >= 1_400, "it waited for the holder");
    } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
    }
});

test("the schema stamp fails closed", { skip }, async () => {
    const was = REQUIRED_SCHEMA.core;
    REQUIRED_SCHEMA.core = 999;
    try {
        const why = await checkSchemaStamp();
        assert.match(String(why), /core is v\d+ in the database, this build needs v999/);
        const r = await pgRunPayload({ query: "SELECT 1 AS ok", params: [] });
        assert.equal(r.success, false);
        await assert.rejects(pgWithWriteTx(async () => 1), /schema is behind/);
    } finally {
        REQUIRED_SCHEMA.core = was;
        assert.equal(await checkSchemaStamp(), null);
    }
});

test("queued writes are held, not parked, while the pg engine cannot run - and drain once it can", { skip }, async () => {
    // One queued pg write, as an outage would have left it: harmless (no row 0).
    const entry = {
        id: "pgport-test-1", seq: 1, createdAt: nowLocal(), kind: "heartbeat", attempts: 0, engine: "pg",
        statements: [{ query: "UPDATE HARNBUILDSEGMENTS SET heartbeatAt = ? WHERE segmentId = ?", params: [nowLocal(), 0] }],
    };
    const seed = (dir: string) => fs.writeFileSync(path.join(dir, "pending-writes.jsonl"), JSON.stringify(entry) + "\n");
    // 1. The password file is missing: the engine never starts.
    const broken = { ...env!.rawConfig, pg: { ...env!.rawConfig.pg, passwordFile: path.join(os.tmpdir(), "no-such-pg-password-file") } };
    let server = await startServer(broken, "held", { waitReadable: false, before: seed });
    try {
        await new Promise((r) => setTimeout(r, 17_000)); // past the first 15 s flush tick
        const q = await api("/api/write-queue");
        assert.equal(q.result.pending, 1, "still waiting");
        assert.equal(q.result.rejected.length, 0, "not parked");
        assert.match(fs.readFileSync(path.join(server.dir, "pending-writes.jsonl"), "utf-8"), /pgport-test-1/, "still on disk");
    } finally {
        await server.stop();
    }
    // 2. A working config with the same queue file: it goes through.
    const heldDir = server.dir;
    server = await startServer(env!.rawConfig, "drain", { before: (dir) => fs.copyFileSync(path.join(heldDir, "pending-writes.jsonl"), path.join(dir, "pending-writes.jsonl")) });
    try {
        const deadline = Date.now() + 25_000;
        let q: any;
        do {
            await new Promise((r) => setTimeout(r, 1_000));
            q = await api("/api/write-queue");
        } while (q.result.pending > 0 && Date.now() < deadline);
        assert.equal(q.result.pending, 0, "drained");
        assert.equal(q.result.rejected.length, 0);
    } finally {
        await server.stop();
    }
});
