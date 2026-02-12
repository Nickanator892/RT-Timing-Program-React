import "./analyticsPage.css"
import { useEffect, useState } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import type { User } from "../../assets/types/UserType";
import AnalyticsChart from "../../common/analyticsChart/chart";
import useTimes from "../../hooks/loggedTimesHook";
import type { LoggedTime } from "../../hooks/loggedTimesHook";


interface analyticsPageProps {
    harn?: string;
}

function AnalyticsPage({ harn }: analyticsPageProps) {
    const [displayTimer] = useSharedState<string>("displayTimer", "00:00:00");
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const [selectedUser] = useSharedState<User | null>("selectedUser", null);
    const [buildTimeEst, setBuildTimeEst] = useState({seconds: 350, formattedTime: "01:00:00"})
    
    const { loggedTimes, fetchTimes } = useTimes();
    
    useEffect(() => {
        if (harn) {
            fetchTimes(harn);
        }
    }, [harn]);

    console.log("harn", harn, "times", loggedTimes);

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

    function createInfoElement() {
        let selectedUserTag = null
        if (selectedUser) {
            selectedUserTag = (
                    <p>User: {selectedUser.name}</p>
            )
        }
        return (
            selectedUserTag
        )
    }

    function checkIsRunning() {
        return isRunning ? (
            <div className="indication-div-on"></div>
        ) : (
            <div className="indication-div-off"></div>
        )
    }

    return (
        <div>
                <div className="timer-info">
                    <p className="timer">{displayTimer}</p>
                    {checkIsRunning()}
                </div>

                <div className="harn-build-chart-info">
                    <p id="current-build-pn">Part #: {harn}</p>
                    <p id="build-time-estimate">Estimate: {Math.round(buildTimeEst.seconds / 60)} Minutes</p>
                    {createInfoElement()}
                </div>
            <div className="build-chart">
                <AnalyticsChart 
                    loggedTimes={times} 
                    harnNumber={harn || "HYSV-10001-R5"} 
                    buildNumber={30} 
                    buildTimeEst={buildTimeEst}
                    currentTimeSeconds={displayTimer}
                />
            </div>
            <div id="RT-logo">
                    <p id="RT-part-one">RT </p> <p id="RT-part-two">Technologies</p>
            </div>
        </div>

    );
}

export default AnalyticsPage;