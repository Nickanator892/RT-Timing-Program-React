import { useEffect, useState } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import type { User } from "../../assets/types/UserType";
import AnalyticsChart from "../../common/analyticsChart/chart";
import useTimes from "../../hooks/loggedTimesHook";
import type { LoggedTime } from "../../hooks/loggedTimesHook";

interface Session {
    user: User;
    startTime: string;
    endTime: string;
    duration: number;
    pauseReason?: string;
}

interface analyticsPageProps {
    harn?: string;
}

function AnalyticsPage({ harn }: analyticsPageProps) {
    const [displayTimer] = useSharedState<string>("displayTimer", "00:00:00");
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const [selectedUser] = useSharedState<User | null>("selectedUser", null);
    const [sessions] = useSharedState<Session[]>("sessions", []);
    
    // Get the hook functions
    const { loggedTimes, fetchTimes } = useTimes();
    
    // Fetch times when harn changes
    useEffect(() => {
        if (harn) {
            fetchTimes(harn);
        }
    }, [harn]); // Only run when harn changes

    console.log("harn", harn, "times", loggedTimes);

    // Process the times data
    const times: { seconds: number; formattedTime: string }[] = [];
    
    if (harn && loggedTimes && Array.isArray(loggedTimes)) {
        loggedTimes.forEach((time: LoggedTime) => {
            times.push({
                seconds: time.seconds,
                formattedTime: time.formattedTime
            });
        });
        console.log(times);
    }

    return (
        <div>
            <AnalyticsChart 
                loggedTimes={times} 
                harnNumber={harn || "HYSV-10001-R5"} 
                buildNumber={30} 
                buildTimeEst={{seconds: 350, formattedTime: "01:00:00"}}
            />
        </div>
    );
}

export default AnalyticsPage;