import { execQuery } from "./execQueryFunction";
import { crewPerUnit, type CrewStretch, type UnitCrew } from "./crewSlices";
import { dbEngine } from "./dbEngine";

/** Local time as "YYYY-MM-DD HH:mm:ss" - text-sortable and new Date() parseable. */
export function formatTimestamp(d: Date): string {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
        d.getMinutes()
    )}:${p(d.getSeconds())}`;
}

/**
 * Tolerant timestamp parser: handles the current "YYYY-MM-DD HH:mm:ss" format
 * and the legacy "dd/mm/yyyy-HH:mm:ss" rows written before the format change
 * (which new Date() cannot parse - they made analytics durations NaN).
 * Returns null when the string is unparseable either way.
 */
export function parseTimestamp(s: string | null | undefined): Date | null {
    if (!s) return null;
    const legacy = /^(\d{2})\/(\d{2})\/(\d{4})-(\d{2}:\d{2}:\d{2})$/.exec(s);
    const d = legacy ? new Date(`${legacy[3]}-${legacy[2]}-${legacy[1]}T${legacy[4]}`) : new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

export interface DistributedTimeArgs {
    harnNumber: string;
    rev: number | undefined;
    builderId: number | undefined;
    timeTypeId: number;
    /** How many physical units the timed window covered. */
    units: number;
    /** Wall-clock window of the whole batch operation. */
    startMs: number;
    endMs: number;
    /**
     * Pause-free worked time across that window. Defaults to the whole span,
     * which is only right when nothing was paused.
     *
     * The two are deliberately separate. The segment STAMPS stay wall-clock so
     * each row sits where the work actually happened, while accumSeconds - the
     * duration the analytics view sums - carries only the earned time. A normal
     * build already has exactly this shape: its segment span covers the pause,
     * its accumSeconds does not.
     */
    workedMs?: number;
    numberOfBuilders: number;
    secondaryBuilderIds: number[];
    /**
     * Randy, 2026-09-25: the extra-units question (Build mode only, see
     * timingPage.tsx submitBatch) - set when this batch covers more units than
     * the schedule has left. Applies to the EXCESS units only, so it is
     * threaded through here rather than written as one blanket UPDATE after
     * the fact: `excessUnits` says how many of the LAST slices (the ones that
     * were not actually owed) carry it. Written into the same INSERT that
     * creates each row's HARNBUILDTIMES record, which happens before that
     * unit's HARNBUILDSEGMENTS row is inserted ALREADY CLOSED (a batch slice
     * has no open segment ever - its endTime is set at creation) - so the flag
     * is on record before the RT-MCS consume sweep, which acts on closed
     * sessions, can ever see the row.
     */
    unitDecision?: "EXTRA" | "SPREAD";
    /** How many of the `units` slices (counting from the END) get unitDecision.
     *  0 or omitted writes no flag at all - the default, unaffected path. */
    excessUnits?: number;
    /**
     * Randy, 2026-10-07: the live build's segments and who was on each
     * (crewSlices.ts). When given, every unit gets an equal share of every
     * segment - one closed segment per live segment, each with that segment's
     * primary, head-count and crew - and the units' seconds come from the
     * segments rather than from workedMs. builderId, numberOfBuilders and
     * secondaryBuilderIds above are then not used for the units: each unit's
     * SECONDARYBUILDERS is everyone in the crew of the pieces it got. Omitted
     * or empty (manual entry, or a batch whose Start was never recorded):
     * every unit gets those three as before.
     */
    crewStretches?: CrewStretch[];
    /** Write HARNBUILDSEGCREW rows for each segment (only once RT-MCS has
     *  created the table - see crewSlices.ts). Manual entry never does: it has
     *  a head-count and no names. */
    writeSegCrew?: boolean;
    /** Timer:SharedSessions packaging (Randy 2026-10-16): the harness of each
     *  unit, in order - one unit per checked quantity, so each harness gets
     *  its quantity's share. Omitted: every unit is harnNumber, as always. */
    unitHarns?: string[];
    /** Harness Steps (HPP docs/HARNESS-STEPS-DESIGN.md section 5): the operator's
     *  "finished this step for these units?" answer per harness, 1 = finished,
     *  0 = part only. Written to HARNBUILDTIMES.stepdone; a harness not listed
     *  (every step but Prebuild and Strip & Crimp) leaves it NULL. */
    stepDoneByHarn?: Record<string, 0 | 1>;
}

/** One unit's rows, worked out before anything is written. */
export interface DistributedUnit {
    harnNumber: string;
    builderId: number | null | undefined;
    numberOfBuilders: number;
    /** Set only on the excess units (see DistributedTimeArgs.unitDecision). */
    unitDecision: "EXTRA" | "SPREAD" | null;
    /** HARNBUILDTIMES.stepdone; null writes no value (see stepDoneByHarn). */
    stepDone: 0 | 1 | null;
    segments: {
        startTime: string;
        endTime: string;
        numberOfBuilders: number;
        accumSeconds: number;
        builderId: number | null;
        crewIds: number[];
    }[];
    secondaryIds: number[];
}

/**
 * The rows writeDistributedTimes writes, unit by unit, without writing them.
 * Pure, so the same plan goes to either engine.
 */
export function planDistributedTimes(args: DistributedTimeArgs): DistributedUnit[] {
    const units: DistributedUnit[] = [];
    const sliceMs = (args.endMs - args.startMs) / args.units;
    // The share of EARNED time each unit gets. Falls back to the wall-clock
    // slice for callers that have no separate worked total (manual entry, where
    // the operator types the time they actually worked).
    const workedSlice = (args.workedMs ?? args.endMs - args.startMs) / args.units;
    const excessUnits = Math.max(0, Math.min(args.units, Math.floor(args.excessUnits ?? 0)));
    const unitSeconds = Math.max(0, Math.round(workedSlice / 1000));
    // Each unit's share of every live segment. null keeps the one-roster-for-
    // every-unit path exactly as it was.
    const unitCrews: UnitCrew[] | null =
        args.crewStretches && args.crewStretches.length ? crewPerUnit(args.crewStretches, args.units) : null;
    for (let k = 0; k < args.units; k++) {
        const crew = unitCrews?.[k];
        const builderId = crew ? crew.builderId ?? args.builderId ?? null : args.builderId;
        const numberOfBuilders = crew ? crew.numberOfBuilders : args.numberOfBuilders;
        const secondaryBuilderIds = crew ? crew.secondaryIds : args.secondaryBuilderIds;
        const pieces = crew
            ? crew.pieces
            : [
                  {
                      share: 1,
                      seconds: unitSeconds,
                      primaryId: args.builderId ?? null,
                      crewIds: args.secondaryBuilderIds.map(Number).filter((id) => id !== Number(args.builderId ?? -1)),
                      numberOfBuilders: args.numberOfBuilders,
                  },
              ];

        // The LAST `excessUnits` slices are the ones that were not actually
        // owed - see the doc comment on DistributedTimeArgs.unitDecision.
        const isExcessRow = args.unitDecision != null && k >= args.units - excessUnits;

        // accumSeconds must be written here too: it is the duration authority
        // the analytics view sums, so a batch segment without it charts as zero.
        // builderId as well: every other writer of a segment stamps it, and a
        // batch that left it NULL would be the one shape of build whose
        // per-person time cannot be read back off the segment rows.
        //
        // One segment per live segment (one, unless the crew changed during
        // the run), back to back inside the unit's wall-clock slice. Each
        // carries its own primary, head-count and - in HARNBUILDSEGCREW - the
        // names of everyone else on it, so per-person hours add up.
        const sliceStart = args.startMs + k * sliceMs;
        let shareBefore = 0;
        const segments: DistributedUnit["segments"] = [];
        for (let j = 0; j < pieces.length; j++) {
            const p = pieces[j];
            const pieceStart = sliceStart + shareBefore * sliceMs;
            shareBefore += p.share;
            const pieceEnd = j === pieces.length - 1 ? args.startMs + (k + 1) * sliceMs : sliceStart + shareBefore * sliceMs;
            segments.push({
                startTime: formatTimestamp(new Date(pieceStart)),
                endTime: formatTimestamp(new Date(pieceEnd)),
                numberOfBuilders: p.numberOfBuilders,
                accumSeconds: p.seconds,
                builderId: p.primaryId ?? builderId ?? null,
                crewIds: p.crewIds,
            });
        }
        const harnNumber = args.unitHarns?.[k] || args.harnNumber;
        const stepDone = args.stepDoneByHarn?.[harnNumber];
        units.push({
            harnNumber,
            builderId,
            numberOfBuilders,
            unitDecision: isExcessRow ? args.unitDecision ?? null : null,
            stepDone: stepDone === 0 || stepDone === 1 ? stepDone : null,
            segments,
            secondaryIds: secondaryBuilderIds,
        });
    }
    return units;
}

/**
 * Records one timed window that covered `units` physical units of a PN -
 * batched operations like "strip every cable for all 12 harnesses" or a
 * manually entered total. Writes the exact same row shape as a normal
 * single-unit session, once per unit, with the window sliced into equal
 * consecutive segments: unit counts, progress bars, the analytics chart, and
 * HARNBUILDTIMES_VIEW all work unchanged, and each unit carries the honest
 * per-unit average. With `crewStretches`, each unit gets one segment per live
 * segment, like a single build that rolled. Returns the new buildIds (first =
 * oldest slice).
 *
 * On PostgreSQL the whole batch is ONE server-side transaction
 * (/api/build/batch): RT-MCS groups a session's units by consecutive build
 * ids, which only one transaction holding its lock can promise there.
 */
export async function writeDistributedTimes(args: DistributedTimeArgs): Promise<number[]> {
    const plan = planDistributedTimes(args);
    if (dbEngine() === "pg") return writeBatchPg(args, plan);
    const buildIds: number[] = [];
    for (const unit of plan) {
        const builderId = unit.builderId;
        const numberOfBuilders = unit.numberOfBuilders;
        const insert = (await execQuery("INSERT INTO HARNBUILDS (harnNumber) VALUES(?)", [
            unit.harnNumber,
        ])) as { lastID?: number } | undefined;
        const buildId = Number(insert?.lastID ?? 0);
        if (!buildId) throw new Error("Failed to create build row");
        buildIds.push(buildId);

        // unitDecision and stepdone only when set, so a database without
        // either column still takes every other unit.
        const timeCols = ["buildId", "harnNumber", "REV", "builderId", "timeTypeId", "numberOfBuilders"];
        const timeVals: unknown[] = [buildId, unit.harnNumber, args.rev, builderId, args.timeTypeId, numberOfBuilders];
        if (unit.unitDecision != null) {
            timeCols.push("unitDecision");
            timeVals.push(unit.unitDecision);
        }
        if (unit.stepDone != null) {
            timeCols.push("stepdone");
            timeVals.push(unit.stepDone);
        }
        await execQuery(
            `INSERT INTO HARNBUILDTIMES (${timeCols.join(", ")}) VALUES(${timeCols.map(() => "?").join(", ")})`,
            timeVals
        );
        for (const seg of unit.segments) {
            const primaryId = seg.builderId;
            const segment = (await execQuery(
                `INSERT INTO HARNBUILDSEGMENTS
                    (buildId, startTime, endTime, numberOfBuilders, accumSeconds, builderId)
                 VALUES(?, ?, ?, ?, ?, ?)`,
                [buildId, seg.startTime, seg.endTime, seg.numberOfBuilders, seg.accumSeconds, primaryId]
            )) as { lastID?: number } | undefined;
            const segmentId = Number(segment?.lastID ?? 0);
            if (args.writeSegCrew && segmentId) {
                for (const crewId of seg.crewIds) {
                    if (Number(crewId) === Number(primaryId ?? -1)) continue;
                    await execQuery("INSERT INTO HARNBUILDSEGCREW (segmentId, buildId, builderId) VALUES (?, ?, ?)", [
                        segmentId,
                        buildId,
                        crewId,
                    ]);
                }
            }
        }
        // Randy, 2026-09-25: nobody is the builder AND the second operator on
        // the same segment - that bills one pair of hands as two. The picker
        // (secondOperator.tsx) already excludes the primary from its
        // candidate list, but this writes straight from shared state, so it
        // gets its own defensive filter rather than trusting every caller
        // upstream got that right.
        for (const secondaryId of unit.secondaryIds) {
            if (Number(secondaryId) === Number(builderId ?? -1)) continue;
            await execQuery("INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)", [
                buildId,
                secondaryId,
            ]);
        }
    }
    return buildIds;
}

/** PostgreSQL: the planned units in one transaction (server.ts /api/build/batch). */
async function writeBatchPg(args: DistributedTimeArgs, units: DistributedUnit[]): Promise<number[]> {
    const response = await fetch("http://localhost:5000/api/build/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            harnNumber: args.harnNumber,
            rev: args.rev ?? null,
            timeTypeId: args.timeTypeId,
            writeSegCrew: args.writeSegCrew === true,
            units,
        }),
    });
    const data = await response.json().catch(() => null);
    if (!data?.success) throw new Error(String(data?.error ?? `batch write failed (HTTP ${response.status})`));
    const buildIds = (data.result?.buildIds ?? []).map(Number);
    if (buildIds.length !== units.length || buildIds.some((id: number) => !(id > 0))) {
        throw new Error("Failed to create build row");
    }
    return buildIds;
}
