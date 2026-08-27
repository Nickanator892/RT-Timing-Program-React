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

    // Completed builds only (open endTime = a run still in progress): an
    // in-progress build otherwise charts as a 0-minute point and bumps the
    // built counts the moment its timer starts - the live run is already
    // represented by the "Current" line on the chart.
    async function fetchTimes(harnNumber: string, timeTypeId: number) {
        if (!harnNumber) return;
        const result = await execQuery(
            "SELECT * FROM HARNBUILDTIMES_VIEW WHERE harnNumber = ? AND timeTypeId = ? AND COALESCE(endTime, '') != '' ORDER BY startTime ASC",
            [harnNumber, timeTypeId]
        );
        if (Array.isArray(result)) {
            setLoggedTimes(result);
            return result;
        }
    }

    async function fetchAllTimes(REV: number | undefined, timeTypeId: number): Promise<HarnCount[]> {
        const result = await execQuery(
            "SELECT harnNumber, COUNT(harnNumber) as count FROM HARNBUILDTIMES_VIEW WHERE REV=? AND timeTypeId=? AND COALESCE(endTime, '') != '' GROUP BY harnNumber",
            [REV, timeTypeId]
        );
        return Array.isArray(result)
            ? result.map((r: any) => ({
                harnNumber: r.harnNumber,
                count: Number(r.count),
            }))
            : [];
    }

    async function writeTime(time: Partial<LoggedTime>, buildId: number, userId: number | undefined) {
        try {
            if (userId) {
                // Close the final segment
                const result = await execQuery(
                    "UPDATE HARNBUILDSEGMENTS SET endTime=? WHERE buildId=? AND endTime=''",
                    [time.endTime, buildId]
                );
                return result;
            }
        } catch (err: any) {
            console.log(err);
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
