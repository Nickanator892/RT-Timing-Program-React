import { useEffect, useState } from "react";

export interface LoggedTime {
    startTime: Date;
    endTime: Date;
    seconds: number;
    formattedTime: string
    harnNumber: string;
    dateBuilt: Date
}


export function useTimes() {
    const [loggedTimes, setLoggedTimes] = useState<LoggedTime[] | unknown>()

    const execQuery = async (requestedQuery: string, params: unknown[] = []): Promise<LoggedTime[] | unknown> => {
        console.log(requestedQuery)
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
            const dataToReturn: LoggedTime[] = data.result
            return dataToReturn;
        } catch (err: any) {
            console.log(err)
        }
    };

    async function fetchTimes(harnNumber: string) {
        if (!harnNumber) return;
        const result = await execQuery(
            "SELECT * FROM times WHERE harnNumber = (?) ORDER BY dateBuilt ASC, startTime ASC",
            [harnNumber]
        );
        console.log(result)

        if (Array.isArray(result)) {
            setLoggedTimes(result);
        }
    }
    
    async function writeTime(time: LoggedTime) {
        try {
            const result = await execQuery(
                "INSERT INTO times (startTime, endTime, seconds, formattedTime, harnNumber, dateBuilt) VALUES (?, ?, ?, ?, ?, ?)",
                 [time.startTime, time.endTime, time.seconds, time.formattedTime, time.harnNumber, time.dateBuilt]
            )
            return result
        } catch (err: any) {
            console.log(err)
        }
    }

    return {
        loggedTimes,
        setLoggedTimes,
        writeTime,
        fetchTimes
    };

}

export default useTimes