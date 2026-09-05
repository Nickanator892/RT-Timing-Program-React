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
    for (let k = 0; k < args.units; k++) {
        const insert = (await execQuery("INSERT INTO HARNBUILDS (harnNumber) VALUES(?)", [
            args.harnNumber,
        ])) as { lastID?: number } | undefined;
        const buildId = Number(insert?.lastID ?? 0);
        if (!buildId) throw new Error("Failed to create build row");
        buildIds.push(buildId);

        await execQuery(
            "INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders) VALUES(?, ?, ?, ?, ?, ?)",
            [buildId, args.harnNumber, args.rev, args.builderId, args.timeTypeId, args.numberOfBuilders]
        );
        // accumSeconds must be written here too: it is the duration authority
        // the analytics view sums, so a batch segment without it charts as zero.
        await execQuery(
            `INSERT INTO HARNBUILDSEGMENTS
                (buildId, startTime, endTime, numberOfBuilders, accumSeconds)
             VALUES(?, ?, ?, ?, ?)`,
            [
                buildId,
                formatTimestamp(new Date(args.startMs + k * sliceMs)),
                formatTimestamp(new Date(args.startMs + (k + 1) * sliceMs)),
                args.numberOfBuilders,
                Math.max(0, Math.round(workedSlice / 1000)),
            ]
        );
        for (const secondaryId of args.secondaryBuilderIds) {
            await execQuery("INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)", [
                buildId,
                secondaryId,
            ]);
        }
    }
    return buildIds;
}
