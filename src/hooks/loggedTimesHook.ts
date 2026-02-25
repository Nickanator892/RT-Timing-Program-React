import { useEffect, useState } from "react";
import { useSharedState } from "./useSharedState"; // Import your shared state hook

export interface LoggedTime {
    startTime: string;
    endTime: string;
    seconds: number;
    formattedTime: string;
    harnNumber: string;
    dateBuilt: string;
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
        console.log(requestedQuery);
        try {
            const response = await fetch("http://localhost:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: requestedQuery, params }),
            });
            console.log(`RESPONSE: ${response}`);
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
        console.log("Fetch result:", result);

        if (Array.isArray(result)) {
            setLoggedTimes(result); // This now updates shared state
            return result;
        }
    }

    async function writeTime(time: LoggedTime) {
        try {
            const result = await execQuery(
                "INSERT INTO HARNBUILDTIMES (startTime, endTime, seconds, formattedTime, harnNumber, dateBuilt) VALUES (?, ?, ?, ?, ?, ?)",
                [
                    time.startTime,
                    time.endTime,
                    time.seconds,
                    time.formattedTime,
                    time.harnNumber,
                    time.dateBuilt,
                ]
            );
            return result;
        } catch (err: any) {
            console.log(err);
        }
    }

    return {
        loggedTimes,
        setLoggedTimes,
        writeTime,
        fetchTimes,
    };
}

export default useTimes;
