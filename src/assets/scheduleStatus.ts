import { execQuery } from "./execQueryFunction";
import type { BuildKit } from "../hooks/useBuildKit";

/**
 * Ahead/behind-schedule math for the analytics screen.
 *
 * The schedule window comes from the pricing program's build schedule
 * (BUILDLST/BUILDHARNLST target dates for the run). Progress is earned value:
 * every completed unit earns its per-unit target build minutes, and the pace
 * expected by now is the planned total scaled by how much of the window's
 * WORKING time (Mon-Fri, 08:00-15:30, the scheduler's 7.5 h days) has elapsed.
 */

export interface ScheduleWindow {
    start: Date;
    end: Date;
    /** True when the window was shifted to the first logged build because the
     *  scheduled dates predate the work actually starting. */
    anchored: boolean;
}

export interface ScheduleStatus {
    workdayOf: number;
    totalWorkdays: number;
    plannedMin: number;
    earnedMin: number;
    expectedMin: number;
    /** positive = ahead of schedule, negative = behind */
    deltaMin: number;
    pastEnd: boolean;
}

/**
 * Parses the pricing program's schedule dates. HPP writes
 * "yyyy/MM/dd HH:mm:ss" (which new Date() accepts); very old rows used
 * "dd/MM/yyyy h:mm:ss AM|PM" and are handled explicitly. Returns null when
 * unparseable - the caller shows "no schedule" rather than garbage.
 */
export function parseScheduleDate(s: string | null | undefined): Date | null {
    if (!s) return null;
    const legacy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ -](\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(s);
    if (legacy) {
        let hours = Number(legacy[4]);
        const ampm = legacy[7]?.toUpperCase();
        if (ampm === "PM" && hours < 12) hours += 12;
        if (ampm === "AM" && hours === 12) hours = 0;
        const d = new Date(
            Number(legacy[3]), Number(legacy[2]) - 1, Number(legacy[1]),
            hours, Number(legacy[5]), Number(legacy[6])
        );
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Target window of the run's most recent build schedule, or null when none.
 * Pricing-time schedules can predate the actual build by months; when the
 * whole window ended before the first logged build, the window is shifted to
 * start at that first build (same duration) so the banner measures pace
 * against a schedule that reflects reality - flagged via `anchored`.
 */
export async function fetchScheduleWindow(rev: number): Promise<ScheduleWindow | null> {
    const rows = (await execQuery(
        `SELECT MIN(BHL.BHLTARGSTRTDATE) AS windowStart, MAX(BHL.BHLTARGENDDATE) AS windowEnd
         FROM BUILDHARNLST BHL
         WHERE BHL.BLID = (SELECT MAX(BLID) FROM BUILDLST WHERE REV = ?)`,
        [rev]
    )) as { windowStart: string | null; windowEnd: string | null }[] | undefined;
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const start = parseScheduleDate(rows[0].windowStart);
    const end = parseScheduleDate(rows[0].windowEnd);
    if (!start || !end || end <= start) return null;

    const firstRows = (await execQuery(
        `SELECT MIN(s.startTime) AS firstStart
         FROM HARNBUILDSEGMENTS s
         JOIN HARNBUILDTIMES h ON h.buildId = s.buildId
         WHERE h.REV = ?`,
        [rev]
    )) as { firstStart: string | null }[] | undefined;
    const firstBuild = Array.isArray(firstRows) ? parseScheduleDate(firstRows[0]?.firstStart) : null;
    if (firstBuild && end < firstBuild) {
        const shift = firstBuild.getTime() - start.getTime();
        return {
            start: firstBuild,
            end: new Date(end.getTime() + shift),
            anchored: true,
        };
    }
    return { start, end, anchored: false };
}

const DAY_START_H = 8;
const DAY_END_H = 15.5; // 08:00 + 7.5 working hours
const WORKDAY_MIN = (DAY_END_H - DAY_START_H) * 60;

function isWorkday(d: Date): boolean {
    return d.getDay() !== 0 && d.getDay() !== 6;
}

/** Working minutes between two instants: Mon-Fri, 08:00-15:30 only. */
export function workingMinutesBetween(from: Date, to: Date): number {
    if (to <= from) return 0;
    let total = 0;
    const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    while (cursor <= to) {
        if (isWorkday(cursor)) {
            const dayStart = new Date(cursor).setHours(DAY_START_H, 0, 0, 0);
            const dayEnd = new Date(cursor).setHours(15, 30, 0, 0);
            const s = Math.max(dayStart, from.getTime());
            const e = Math.min(dayEnd, to.getTime());
            if (e > s) total += (e - s) / 60000;
        }
        cursor.setDate(cursor.getDate() + 1);
    }
    return total;
}

/**
 * Earned-value status for the kit. `unitsDone` is completed units per PN
 * (Build-mode counts - the same numbers behind the progress bars).
 */
export function computeScheduleStatus(
    kit: BuildKit,
    unitsDone: Record<string, number>,
    win: ScheduleWindow,
    now: Date = new Date()
): ScheduleStatus {
    let plannedMin = 0;
    let earnedMin = 0;
    for (const h of kit.harnesses) {
        const perUnitMin = h.buildTargetTime.seconds / 60;
        plannedMin += h.buildNumber * perUnitMin;
        earnedMin += Math.min(unitsDone[h.partNum] ?? 0, h.buildNumber) * perUnitMin;
    }
    const windowMin = workingMinutesBetween(win.start, win.end);
    const elapsedMin = workingMinutesBetween(win.start, now);
    const frac = windowMin > 0 ? Math.min(1, elapsedMin / windowMin) : 1;
    const expectedMin = plannedMin * frac;
    return {
        workdayOf: Math.min(
            Math.max(1, Math.ceil(elapsedMin / WORKDAY_MIN)),
            Math.max(1, Math.ceil(windowMin / WORKDAY_MIN))
        ),
        totalWorkdays: Math.max(1, Math.ceil(windowMin / WORKDAY_MIN)),
        plannedMin,
        earnedMin,
        expectedMin,
        deltaMin: earnedMin - expectedMin,
        pastEnd: now > win.end,
    };
}
