// PostgreSQL transport, the parts that need no database.
//   npx tsx --test tests/pg/unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { caseInfo, readPgConfig, restoreKey, toPgPlaceholders, pgErrorMessage } from "../../src/backend/pgEngine.ts";

test("? becomes $n outside strings, quoted names and comments", () => {
    assert.equal(toPgPlaceholders("SELECT a FROM t WHERE x = ? AND y = ?"), "SELECT a FROM t WHERE x = $1 AND y = $2");
    assert.equal(
        toPgPlaceholders(`SELECT '?' AS "q?", x FROM t -- what?\nWHERE y = ? /* ? */ AND z = 'it''s ?' AND w = ?`),
        `SELECT '?' AS "q?", x FROM t -- what?\nWHERE y = $1 /* ? */ AND z = 'it''s ?' AND w = $2`
    );
    assert.equal(toPgPlaceholders("VALUES(?, ?::integer, (?))"), "VALUES($1, $2::integer, ($3))");
});

test("keys come back as the query spelled them", () => {
    const sql = `SELECT s.segmentId, b.harnNumber, h.REV, bl.userName AS builderName,
                        COUNT(*) AS n, (SELECT MIN(startTime) FROM X) AS buildStartTime
                   FROM HARNBUILDSEGMENTS s WHERE s.stationId = ?`;
    const info = caseInfo(sql);
    for (const [pg, want] of [
        ["segmentid", "segmentId"],
        ["harnnumber", "harnNumber"],
        ["rev", "REV"],
        ["buildername", "builderName"],
        ["n", "n"],
        ["buildstarttime", "buildStartTime"],
    ]) {
        assert.equal(restoreKey(pg, info), want, pg);
    }
});

test("an alias wins over other spellings of the same name", () => {
    const info = caseInfo("SELECT B.Id AS Id, B.userName AS name FROM SECONDARYBUILDERS S JOIN HARNBUILDERS B ON B.id = S.builderId");
    assert.equal(restoreKey("id", info), "Id");
    assert.equal(restoreKey("name", info), "name");
});

test("SELECT * uses the SQLite declarations", () => {
    const users = caseInfo("SELECT * FROM HARNBUILDERS WHERE active != 0");
    assert.deepEqual(
        ["id", "username", "password", "privlevel", "active", "qbtimeuserid", "qbautopause"].map((k) => restoreKey(k, users)),
        ["Id", "userName", "password", "privLevel", "active", "qbTimeUserId", "qbAutoPause"]
    );
    const view = caseInfo("SELECT * FROM HARNBUILDTIMES_VIEW WHERE harnNumber = ? AND timeTypeId = ? AND openSegments = 0 ORDER BY startTime ASC");
    assert.deepEqual(
        ["harnbuildtimeid", "rev", "opensegments", "laborseconds", "pausedseconds", "starttime"].map((k) => restoreKey(k, view)),
        ["harnBuildTimeId", "REV", "openSegments", "laborSeconds", "pausedSeconds", "startTime"]
    );
    // QBTIMEUSERS spells it username, HARNBUILDERS userName: the text decides.
    assert.equal(restoreKey("username", caseInfo("SELECT qbTimeUserId, displayName, username, active FROM QBTIMEUSERS")), "username");
});

test("quoted (already-cased) names pass through", () => {
    assert.equal(restoreKey("Kit Name", caseInfo(`SELECT 1 AS "Kit Name"`)), "Kit Name");
});

test("strings and comments do not lend their spelling", () => {
    const info = caseInfo("SELECT harnNumber FROM T WHERE x = 'HARNNUMBER' -- HarnNumber");
    assert.equal(restoreKey("harnnumber", info), "harnNumber");
});

test("db-config never holds a password", () => {
    const base = { host: "h", database: "d", user: "u" };
    assert.throws(() => readPgConfig({ engine: "pg", pg: { ...base, password: "x" } }), /must not hold a password/);
    assert.throws(() => readPgConfig({ engine: "pg", password: "x", pg: base }), /must not hold a password/);
    assert.throws(() => readPgConfig({ engine: "pg" }), /no "pg" block/);
    const c = readPgConfig({ engine: "pg", pg: base });
    assert.equal(c.port, 5432);
    assert.match(c.passwordFile.replace(/\\/g, "/"), /\.config\/rt-timing\/timing_app\.pw$/);
    assert.match(c.keyFile.replace(/\\/g, "/"), /\.config\/rt-timing\/rtmcs\.key$/);
});

test("errors keep the words the app matches on", () => {
    assert.match(pgErrorMessage({ code: "55P03", message: "canceling statement due to lock timeout" }), /^database busy/);
    assert.match(pgErrorMessage({ code: "40P01", message: "deadlock detected" }), /^database busy/);
    assert.match(pgErrorMessage({ code: "ECONNREFUSED", message: "connect ECONNREFUSED" }), /^PostgreSQL unreachable/);
    assert.match(pgErrorMessage({ code: "57P01", message: "terminating connection" }), /^PostgreSQL unreachable/);
    const onePlace = pgErrorMessage({
        code: "P0001",
        message: "ONE PLACE AT A TIME: this builder already has a build open on another timer station or on the phone timer - pause and finish it there first",
    });
    assert.match(onePlace, /ONE PLACE AT A TIME/);
    assert.match(onePlace, /SQLSTATE P0001/);
});

test("SELECT * keeps the table's spelling even when the WHERE spells it otherwise", () => {
    const info = caseInfo("SELECT * FROM HARNBUILDERS WHERE ID = ? AND USERNAME <> ''");
    assert.equal(restoreKey("id", info), "Id");
    assert.equal(restoreKey("username", info), "userName");
    assert.equal(caseInfo("SELECT COUNT(*) AS n FROM T").selectsAll, false);
    assert.equal(caseInfo("SELECT b.*, 1 AS x FROM HARNBUILDERS b").selectsAll, true);
});
