import { execQuery } from "./execQueryFunction";
import { timerModes } from "../common/timerModeDropdown/timerModeDropdown";

/**
 * "A build the database already closed is never resumed or re-submitted."
 *
 * Randy, 2026-09-25 (see project_pi_session_restore_carryover.md - the RECURRED
 * section): a Submit used to leave the just-finished build's ids sitting in
 * shared state and on disk (session-state.json) until the next Start
 * overwrote them. An operator who powers the panel off within seconds of
 * Submit - routine on the shop floor - restarts into a session that still
 * names the just-closed segment, with the clock showing what it earned and
 * timerDone still false. Nothing before this file ever asked the database
 * "is this actually still open?" before trusting that state.
 *
 * checkSegmentStatus is the one place that question gets asked, from four
 * call sites in timingPage.tsx (boot/restore, the Resume path, the Submit
 * "nomatch" path) and from the carryover lock dialog (before it bothers
 * anyone with "you have unsubmitted time"). All of them funnel into
 * clearCarryoverClock when the answer is "closed".
 */

export type SegmentStatus = "open" | "closed" | "missing" | "unknown" | "none";

export interface SegmentCheckResult {
    status: SegmentStatus;
    /** Ready-to-display text, set only when status is "closed" or "missing". */
    message?: string;
}

/** Same label the mode dropdown itself uses ("Timer Mode: Build" -> "Build"). */
function modeLabel(timeTypeId: number | null | undefined): string {
    const mode = timerModes.find((m) => m.id === Number(timeTypeId));
    return mode ? mode.label.replace("Timer Mode: ", "") : `mode ${timeTypeId ?? "?"}`;
}

/** The "HH:mm:ss" tail of a "YYYY-MM-DD HH:mm:ss" stamp, or null if unparseable. */
function hhmmss(stamp: string | null | undefined): string | null {
    const m = /(\d{2}:\d{2}:\d{2})\s*$/.exec(String(stamp ?? ""));
    return m ? m[1] : null;
}

/**
 * Is a segment id worth checking at all, and if so, is it still open?
 *
 * `displayTimer` is embedded in the notice verbatim - it is what the operator
 * is looking at right now, which is the whole point of the message ("the
 * clock YOU SEE has already been dealt with").
 *
 * Returns "unknown" (never "closed") when the database cannot be read: an
 * unreachable database is not proof of anything, and treating it as stale
 * would clear real, unsubmitted work the moment the network hiccups.
 */
export async function checkSegmentStatus(
    segmentId: number | null | undefined,
    displayTimer: string,
    timeTypeId: number | null | undefined
): Promise<SegmentCheckResult> {
    const id = Number(segmentId ?? 0);
    if (!id || id <= 0) return { status: "none" };

    let rows: unknown;
    try {
        rows = await execQuery(
            `SELECT s.endTime, b.harnNumber, t.REV, t.timeTypeId
               FROM HARNBUILDSEGMENTS s
               JOIN HARNBUILDS b ON b.buildId = s.buildId
          LEFT JOIN HARNBUILDTIMES t ON t.buildId = s.buildId AND t.timeTypeId <> 4
              WHERE s.segmentId = ?
              LIMIT 1`,
            [id]
        );
    } catch {
        return { status: "unknown" };
    }
    // execQuery (see execQueryFunction.ts) returns undefined for any failure -
    // a real SQL error, the database being unreachable, a bad response body.
    // That is indistinguishable from "unknown" on purpose: this function must
    // never clear a clock it cannot actually prove is stale.
    if (!Array.isArray(rows)) return { status: "unknown" };

    if (rows.length === 0) {
        // The segment row itself is gone (e.g. the build was discarded from
        // under this station). Reported distinctly from "closed": submitTime
        // keeps recordAsNewBuild for exactly this case rather than silently
        // dropping time nobody can prove was ever recorded elsewhere.
        return {
            status: "missing",
            message: `${displayTimer} on this build is no longer on record - the clock has been cleared.`,
        };
    }

    const row = rows[0] as { endTime?: string | null; harnNumber?: string; REV?: number; timeTypeId?: number };
    const closed = String(row.endTime ?? "") !== "";
    if (!closed) return { status: "open" };

    const type = row.timeTypeId ?? timeTypeId;
    const rev = row.REV != null ? ` R${row.REV}` : "";
    const at = hhmmss(row.endTime);
    const when = at ? ` at ${at}` : "";
    return {
        status: "closed",
        message:
            `${displayTimer} on ${row.harnNumber ?? "this harness"}${rev} (${modeLabel(type)}) ` +
            `was already submitted${when} - the clock has been cleared.`,
    };
}

/** True for either "closed" or "missing" - both mean "nothing here to resume". */
export function isSegmentStale(status: SegmentStatus): boolean {
    return status === "closed" || status === "missing";
}

/**
 * isRunning OR (not yet submitted AND (real elapsed time OR a real open build
 * pointer)). Shared by the carryover lock and by HandoffOffer's accept() -
 * both have to agree on exactly what "unsubmitted time on the clock" means,
 * because a mismatch between them is exactly the kind of gap this feature
 * exists to close.
 *
 * elapsedTime alone fails open in the window between Start (which opens a
 * real HARNBUILDS/HARNBUILDSEGMENTS row and sets timerDone=false immediately)
 * and the first 1s tick (which is the only thing that ever writes a nonzero
 * elapsedTime into shared state) - see project_timer_shared_state_hazards.md.
 * currentBuildId/currentSegmentId are set at the same moment as timerDone in
 * that Start path, so checking them closes that gap without needing a real
 * elapsed time to have accumulated yet.
 */
export function hasUnsubmittedTime(
    isRunning: boolean | undefined,
    elapsedTime: number | undefined,
    timerDone: boolean | undefined,
    currentBuildId?: number | undefined,
    currentSegmentId?: number | undefined
): boolean {
    if (isRunning) return true;
    if (timerDone !== false) return false;
    if (Number(elapsedTime ?? 0) > 0) return true;
    return Number(currentBuildId ?? 0) > 0 && Number(currentSegmentId ?? 0) > 0;
}

/**
 * Zero the clock and every id that points at the build/segment just found
 * stale, and (if given one) hand the notice to whichever TimingPage instance
 * is listening. Renderer-side only: main.js's own timer-reset handler (see
 * electron/main.js) does the matching reset of sharedTimerData so the on-disk
 * session can never describe a build that was already dealt with.
 *
 * Does NOT touch pauseStart or secondaryBuilders - pauseStart is plain React
 * state owned by TimerLayout, not shared state, so every caller clears it
 * itself right after calling this; secondaryBuilders is already released by
 * TimingPage's existing "harness changed" effect once timerDone flips true.
 */
export function clearCarryoverClock(notice?: string): void {
    window.electron.timerReset();
    window.electron.updateSharedData({
        currentBuildId: 0,
        currentSegmentId: 0,
        timerDone: true,
        startTime: "",
        endTime: "",
        batchPauses: [],
        ...(notice ? { carryoverNotice: notice } : {}),
    });
}
