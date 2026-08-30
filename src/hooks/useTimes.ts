import { useSharedState } from "./useSharedState";

export interface LoggedTime {
    startTime: string;
    endTime: string;
    seconds: number;
    formattedTime: string;
    harnNumber: string;
    dateBuilt: string;
    /** Total recorded pause time within the build's wall-clock span. */
    pausedSeconds?: number;
    /** Sum of per-segment worked seconds. Already pause-free - never subtract
     *  pausedSeconds from it. Gap-safe, so a build interrupted overnight and
     *  resumed the next morning reports the work, not the wall clock. */
    workedSeconds?: number;
    /** Segments still open; > 0 means the build is in progress. */
    openSegments?: number;
}

export interface HarnCount {
    harnNumber: string;
    count: number;
}

export function useTimes() {
    const [loggedTimes, setLoggedTimes] = useSharedState<LoggedTime[] | undefined>(
        "loggedTimes",
        undefined
    );

    const execQuery = async (
        requestedQuery: string,
        params: unknown[] = []
    ): Promise<LoggedTime[] | unknown> => {
        try {
            const response = await fetch("http://localhost:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: requestedQuery, params }),
            });
            const data = await response.json();
            if (data.success === false) {
                return;
            }
            const dataToReturn: LoggedTime[] = data.result;
            return dataToReturn;
        } catch (err: any) {
            console.log(err);
        }
    };

    // Completed builds only. openSegments (not endTime) is the in-progress
    // test: SQLite ranks '' below every timestamp, so MAX(endTime) on a build
    // with one closed and one open segment returns the closed stamp and the
    // build reads as finished - which is exactly the shape a recovered build
    // has. An in-progress build otherwise charts as a 0-minute point and bumps
    // the built counts; the live run is already shown by the "Current" line.
    async function fetchTimes(harnNumber: string, timeTypeId: number) {
        if (!harnNumber) return;
        const result = await execQuery(
            "SELECT * FROM HARNBUILDTIMES_VIEW WHERE harnNumber = ? AND timeTypeId = ? AND openSegments = 0 ORDER BY startTime ASC",
            [harnNumber, timeTypeId]
        );
        if (Array.isArray(result)) {
            setLoggedTimes(result);
            return result;
        }
    }

    async function fetchAllTimes(REV: number | undefined, timeTypeId: number): Promise<HarnCount[]> {
        const result = await execQuery(
            "SELECT harnNumber, COUNT(harnNumber) as count FROM HARNBUILDTIMES_VIEW WHERE REV=? AND timeTypeId=? AND openSegments = 0 GROUP BY harnNumber",
            [REV, timeTypeId]
        );
        return Array.isArray(result)
            ? result.map((r: any) => ({
                harnNumber: r.harnNumber,
                count: Number(r.count),
            }))
            : [];
    }

    /**
     * Close the build's final segment. Targets the segment by id rather than
     * "whichever one is open": a build can legitimately have several segments,
     * and the blanket form stamped every open one with the same end time.
     * Returns false (and reports it) when nothing matched, so a submit against
     * a lost id fails visibly instead of showing Success over an open segment.
     */
    async function writeTime(time: Partial<LoggedTime>, buildId: number, userId: number | undefined) {
        if (!userId) return false;
        try {
            const accumSeconds = await window.electron.getSegmentSeconds();
            const segmentId = Number((await window.electron.getSharedData())?.currentSegmentId ?? 0);
            const result = segmentId
                ? await execQuery(
                      `UPDATE HARNBUILDSEGMENTS
                          SET endTime = ?, accumSeconds = MAX(COALESCE(accumSeconds, 0), ?)
                        WHERE segmentId = ? AND COALESCE(endTime, '') = ''`,
                      [time.endTime, accumSeconds, segmentId]
                  )
                : await execQuery(
                      // Pre-recovery builds started before this release have no
                      // segment id in shared state; fall back to the old form.
                      `UPDATE HARNBUILDSEGMENTS
                          SET endTime = ?, accumSeconds = MAX(COALESCE(accumSeconds, 0), ?)
                        WHERE buildId = ? AND COALESCE(endTime, '') = ''`,
                      [time.endTime, accumSeconds, buildId]
                  );
            const changes = Number((result as any)?.changes ?? 0);
            if (!changes) {
                console.error("writeTime matched no open segment", { buildId, segmentId });
                return false;
            }
            return result;
        } catch (err: any) {
            console.log(err);
            return false;
        }
    }

    return {
        loggedTimes,
        setLoggedTimes,
        writeTime,
        fetchTimes,
        fetchAllTimes,
    };
}

export default useTimes;
