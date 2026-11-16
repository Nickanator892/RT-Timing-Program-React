// "More than the order needs?" on Overmold / Prebuild / Strip & Crimp (Randy
// 2026-11-16), against a PostgreSQL bench clone through the real server:
//
//   PG_BENCH_CONFIG=<db-config.json for a whpp_bench_* clone>
//   node --import tsx --test --test-force-exit tests/pg/stepExtra.test.ts
//
// Proves the Pi writes what the RT-MCS phone timer writes (FloorTimer.cs
// CountedStep / FloorUnitsOn(..., mode) / SubmitCore): the step's count on the
// run is the phone's count, only the units past the order carry the answer,
// EXTRA rows count and SPREAD rows do not, and Build's count is untouched.
// Deletes the rows it writes. Skips without PG_BENCH_CONFIG; refuses anything
// but a whpp_bench_* clone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { readPgConfig } from "../../src/backend/pgEngine.ts";
import { startServer, api, type RunningServer } from "./harness.ts";
import { setDbEngine } from "../../src/assets/dbEngine.ts";
import { writeDistributedTimes, unitsPastOrder } from "../../src/assets/timeDistribution.ts";

const cfgFile = process.env.PG_BENCH_CONFIG;
const rawConfig = cfgFile ? JSON.parse(fs.readFileSync(cfgFile, "utf-8")) : null;
if (rawConfig && !/^whpp_bench_[a-z0-9_]+$/.test(readPgConfig(rawConfig).database)) {
    throw new Error("refusing: bench clones (whpp_bench_*) only");
}
const skip = !rawConfig;

const PREBUILD = 6;
const STRIP_CRIMP = 7;
const SPREAD_EXCLUSION =
    "AND harnBuildTimeId NOT IN (SELECT harnBuildTimeId FROM HARNBUILDTIMES WHERE unitDecision='SPREAD')";

let server: RunningServer | null = null;
const written: number[] = [];
let harn = "";
let rev = 0;
let builderId = 0;

async function q(query: string, params: unknown[] = []): Promise<any[]> {
    const r = await api("/api/query", { query, params });
    if (!r?.success) throw new Error(`query failed: ${r?.error}\n${query}`);
    // A write answers with a change count, not rows.
    return (Array.isArray(r.result) ? r.result : []).map((row: any) =>
        Object.fromEntries(Object.entries(row).map(([k, v]) => [k.toLowerCase(), v]))
    );
}

/** The Pi's count - useTimes.countOnRev's SQL, what the page now asks with. */
async function piCount(mode: number): Promise<number> {
    const rows = await q(
        `SELECT COUNT(*) AS n FROM HARNBUILDTIMES_VIEW WHERE harnNumber = ? AND timeTypeId = ? AND REV = ? AND openSegments = 0 ${SPREAD_EXCLUSION}`,
        [harn, mode, rev]
    );
    return Number(rows[0].n);
}

/** RT-MCS FloorUnitsSql(true) as written in FloorTimer.cs, @-params in order. */
async function phoneUnits(mode: number): Promise<{ built: number; total: number }> {
    const rows = await q(
        `SELECT (SELECT COALESCE(MAX(COALESCE(QTY, 1) *
                    CASE WHEN COALESCE(ALTQTY, 0) = 0
                         THEN COALESCE((SELECT MIN(QTYBREAK) FROM HARNPARTSCOST WHERE RID = ? AND QTYBREAK > 0), 1)
                         ELSE ALTQTY END), 0)
                  FROM PROJHARN WHERE RID = ? AND HARNPN = ?) AS q,
                (SELECT COUNT(*) FROM HARNBUILDTIMES_VIEW T WHERE T.harnNumber = ? AND T.REV = ?
                    AND T.timeTypeId = ? AND T.openSegments = 0
                    AND COALESCE((SELECT unitDecision FROM HARNBUILDTIMES WHERE harnBuildTimeId = T.harnBuildTimeId), '') <> 'SPREAD') AS b`,
        [rev, rev, harn, harn, rev, mode]
    );
    return { built: Number(rows[0].b), total: Math.round(Number(rows[0].q)) };
}

/** A batch submit as submitBatch does it: excess from unitsPastOrder, answer on the trailing units. */
async function submit(mode: number, units: number, decision?: "EXTRA" | "SPREAD"): Promise<{ ids: number[]; excess: number }> {
    const { total } = await phoneUnits(mode);
    const done = await piCount(mode);
    const excess = decision ? unitsPastOrder(units, total, done) : 0;
    const endMs = Date.now() - 60_000 * (written.length + 1);
    const ids = await writeDistributedTimes({
        harnNumber: harn,
        rev,
        builderId,
        timeTypeId: mode,
        units,
        startMs: endMs - units * 60_000,
        endMs,
        numberOfBuilders: 1,
        secondaryBuilderIds: [],
        unitDecision: decision,
        excessUnits: excess,
        stepDoneByHarn: mode === PREBUILD || mode === STRIP_CRIMP ? { [harn]: 1 } : undefined,
    });
    written.push(...ids);
    return { ids, excess };
}

async function decisions(ids: number[]): Promise<(string | null)[]> {
    const rows = await q(
        `SELECT buildId AS id, unitDecision AS d, stepdone AS s FROM HARNBUILDTIMES WHERE buildId IN (${ids.map(() => "?").join(",")}) AND timeTypeId <> 4 ORDER BY buildId`,
        ids
    );
    assert.equal(rows.length, ids.length);
    for (const r of rows) assert.equal(Number(r.s), 1, "the stepdone tick still lands");
    return rows.map((r) => (r.d == null ? null : String(r.d)));
}

before(async () => {
    if (skip) return;
    setDbEngine("pg");
    server = await startServer(rawConfig, "stepextra");
    // A harness on a run with a small order (QTY x ALTQTY) and few Prebuild rows.
    const pick = await q(
        `SELECT PH.RID AS rid, PH.HARNPN AS pn FROM PROJHARN PH
          WHERE COALESCE(PH.QTY, 1) * PH.ALTQTY BETWEEN 4 AND 30
          ORDER BY PH.RID DESC LIMIT 1`
    );
    rev = Number(pick[0].rid);
    harn = String(pick[0].pn);
    builderId = Number((await q("SELECT MIN(Id) AS id FROM HARNBUILDERS"))[0].id);
});

after(async () => {
    if (written.length) {
        const list = written.join(",");
        for (const sql of [
            `DELETE FROM SECONDARYBUILDERS WHERE buildId IN (${list})`,
            `DELETE FROM HARNBUILDSEGMENTS WHERE buildId IN (${list})`,
            `DELETE FROM HARNBUILDTIMES WHERE buildId IN (${list})`,
            `DELETE FROM HARNBUILDS WHERE buildId IN (${list})`,
        ]) {
            await q(sql).catch((e) => console.warn("cleanup:", e?.message ?? e));
        }
    }
    await server?.stop();
});

test("unitsPastOrder is RT-MCS SubmitCore's excess", () => {
    assert.equal(unitsPastOrder(6, 14, 14), 6); // all 14 done: every unit is past the order
    assert.equal(unitsPastOrder(6, 14, 10), 2); // 4 still due: the last 2 are past it
    assert.equal(unitsPastOrder(4, 14, 10), 0); // fits: no question
    assert.equal(unitsPastOrder(3, 14, 20), 3); // already over (EXTRA earlier)
    assert.equal(unitsPastOrder(5, 0, 0), 0); // no order quantity: nothing to be over
});

test("Prebuild / Strip & Crimp: the Pi's count, excess units and answers match the phone", { skip }, async () => {
    const buildBefore = await piCount(1);
    for (const mode of [PREBUILD, STRIP_CRIMP]) {
        const start = await phoneUnits(mode);
        assert.ok(start.total > 0, "the picked harness has an order quantity");
        assert.equal(await piCount(mode), start.built, `mode ${mode}: Pi count = phone count at start`);

        // Fill the step to 2 short of the order - no question, no answers.
        const fill = Math.max(0, start.total - start.built - 2);
        if (fill > 0) {
            const { ids, excess } = await submit(mode, fill);
            assert.equal(excess, 0);
            assert.deepEqual(await decisions(ids), Array(fill).fill(null));
        }
        const before5 = await phoneUnits(mode);
        assert.equal(before5.built, await piCount(mode));
        const due = Math.max(0, before5.total - before5.built);

        // 5 more, "Additional harnesses past the N": only the units past the order are EXTRA.
        const extra = await submit(mode, 5, "EXTRA");
        assert.equal(extra.excess, 5 - due);
        assert.deepEqual(await decisions(extra.ids), [...Array(due).fill(null), ...Array(5 - due).fill("EXTRA")]);
        const afterExtra = await phoneUnits(mode);
        assert.equal(afterExtra.built, before5.built + 5, "EXTRA units count");
        assert.equal(await piCount(mode), afterExtra.built);

        // 4 more on a full step, "Within the N": every unit SPREAD, and none of them count.
        const spread = await submit(mode, 4, "SPREAD");
        assert.equal(spread.excess, 4);
        assert.deepEqual(await decisions(spread.ids), Array(4).fill("SPREAD"));
        const afterSpread = await phoneUnits(mode);
        assert.equal(afterSpread.built, afterExtra.built, "SPREAD units do not count");
        assert.equal(await piCount(mode), afterSpread.built);
    }
    assert.equal(await piCount(1), buildBefore, "Build's own count is untouched by step rows");
});
