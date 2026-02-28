import { useSharedState } from "./useSharedState"; // Import your shared state hook
import { useBuildKit } from "./useBuildKit";

export interface LoggedTime {
    startTime: string;
    endTime: string;
    seconds: number;
    formattedTime: string;
    harnNumber: string;
    dateBuilt: string;
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
    const { buildKit } = useBuildKit();

    const execQuery = async (
        requestedQuery: string,
        params: unknown[] = []
    ): Promise<LoggedTime[] | unknown> => {
        console.log(requestedQuery, " ", params);
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

    async function fetchTimes(harnNumber: string) {
        if (!harnNumber) return;
        const result = await execQuery(
            "SELECT * FROM HARNBUILDTIMES WHERE harnNumber = (?) ORDER BY dateBuilt ASC, startTime ASC",
            [harnNumber]
        );
        if (Array.isArray(result)) {
            setLoggedTimes(result);
            return result;
        }
    }

    async function fetchAllTimes(REV: number | undefined): Promise<HarnCount[]> {
        const result = await execQuery(
            "SELECT harnNumber, COUNT(harnNumber) as count FROM HARNBUILDTIMES WHERE REV=? GROUP BY harnNumber",
            [REV]
        );
        return Array.isArray(result)
            ? result.map((r: any) => ({
                  harnNumber: r.harnNumber,
                  count: Number(r.count),
              }))
            : [];
    }

    async function writeTime(time: LoggedTime, buildId: number, userId: number | undefined) {
        try {
            if (userId) {
                const result = await execQuery(
                    "UPDATE HARNBUILDTIMES SET startTime=?, endTime=?, seconds=?, formattedTime=?, harnNumber=?, dateBuilt=?, REV=?, builderId=? WHERE buildId=?",
                    [
                        time.startTime,
                        time.endTime,
                        time.seconds,
                        time.formattedTime,
                        time.harnNumber,
                        time.dateBuilt,
                        buildKit?.REV,
                        userId,
                        buildId,
                    ]
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
