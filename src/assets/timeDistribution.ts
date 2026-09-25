import { execQuery } from "./execQueryFunction";

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
}

/**
 * Records one timed window that covered `units` physical units of a PN -
 * batched operations like "strip every cable for all 12 harnesses" or a
 * manually entered total. Writes the exact same row shape as a normal
 * single-unit session, once per unit, with the window sliced into equal
 * consecutive segments: unit counts, progress bars, the analytics chart, and
 * HARNBUILDTIMES_VIEW all work unchanged, and each unit carries the honest
 * per-unit average. Returns the new buildIds (first = oldest slice).
 */
export async function writeDistributedTimes(args: DistributedTimeArgs): Promise<number[]> {
    const buildIds: number[] = [];
    const sliceMs = (args.endMs - args.startMs) / args.units;
    // The share of EARNED time each unit gets. Falls back to the wall-clock
    // slice for callers that have no separate worked total (manual entry, where
    // the operator types the time they actually worked).
    const workedSlice = (args.workedMs ?? args.endMs - args.startMs) / args.units;
    const excessUnits = Math.max(0, Math.min(args.units, Math.floor(args.excessUnits ?? 0)));
    for (let k = 0; k < args.units; k++) {
        const insert = (await execQuery("INSERT INTO HARNBUILDS (harnNumber) VALUES(?)", [
            args.harnNumber,
        ])) as { lastID?: number } | undefined;
        const buildId = Number(insert?.lastID ?? 0);
        if (!buildId) throw new Error("Failed to create build row");
        buildIds.push(buildId);

        // The LAST `excessUnits` slices are the ones that were not actually
        // owed - see the doc comment on DistributedTimeArgs.unitDecision.
        const isExcessRow = args.unitDecision != null && k >= args.units - excessUnits;
        if (isExcessRow) {
            await execQuery(
                `INSERT INTO HARNBUILDTIMES
                    (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders, unitDecision)
                 VALUES(?, ?, ?, ?, ?, ?, ?)`,
                [buildId, args.harnNumber, args.rev, args.builderId, args.timeTypeId, args.numberOfBuilders, args.unitDecision]
            );
        } else {
            await execQuery(
                "INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders) VALUES(?, ?, ?, ?, ?, ?)",
                [buildId, args.harnNumber, args.rev, args.builderId, args.timeTypeId, args.numberOfBuilders]
            );
        }
        // accumSeconds must be written here too: it is the duration authority
        // the analytics view sums, so a batch segment without it charts as zero.
        // builderId as well: every other writer of a segment stamps it, and a
        // batch that left it NULL would be the one shape of build whose
        // per-person time cannot be read back off the segment rows.
        await execQuery(
            `INSERT INTO HARNBUILDSEGMENTS
                (buildId, startTime, endTime, numberOfBuilders, accumSeconds, builderId)
             VALUES(?, ?, ?, ?, ?, ?)`,
            [
                buildId,
                formatTimestamp(new Date(args.startMs + k * sliceMs)),
                formatTimestamp(new Date(args.startMs + (k + 1) * sliceMs)),
                args.numberOfBuilders,
                Math.max(0, Math.round(workedSlice / 1000)),
                args.builderId ?? null,
            ]
        );
        // Randy, 2026-09-25: nobody is the builder AND the second operator on
        // the same segment - that bills one pair of hands as two. The picker
        // (secondOperator.tsx) already excludes the primary from its
        // candidate list, but this writes straight from shared state, so it
        // gets its own defensive filter rather than trusting every caller
        // upstream got that right.
        for (const secondaryId of args.secondaryBuilderIds) {
            if (Number(secondaryId) === Number(args.builderId ?? -1)) continue;
            await execQuery("INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)", [
                buildId,
                secondaryId,
            ]);
        }
    }
    return buildIds;
}
