import "./analyticsPage.css";
import { useEffect, useState, useRef } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import type { User } from "../../assets/types/UserType";
import AnalyticsChart from "../../common/analyticsChart/chart";
import useTimes from "../../hooks/loggedTimesHook";
import type { LoggedTime } from "../../hooks/loggedTimesHook";
import { useBuildKit } from "../../hooks/useBuildKit";

interface analyticsPageProps {
    harn?: string;
}

function AnalyticsPage({ harn }: analyticsPageProps) {
    const [displayTimer] = useSharedState<string>("displayTimer", "00:00:00");
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const [selectedUser] = useSharedState<User | null>("selectedUser", null);
    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [refreshTrigger] = useSharedState<number>("refreshTrigger", 0);
    const [buildTimeEst, setBuildTimeEst] = useState<{ seconds: number; formattedTime: string }>({
        seconds: 1,
        formattedTime: "00:00:01",
    });
    const [harnCounts, setHarnCounts] = useState<Record<string, number>>({});
    const [times, setTimes] = useState<{ seconds: number; formattedTime: string }[]>([]);

    const { fetchTimes } = useTimes();
    const { buildKit } = useBuildKit();

    const countsFetched = useRef(false);
    const timesFetched = useRef(false);
    const lastSelectedHarn = useRef("");
    const lastBuildKitRev = useRef<number | null>(null);

    // Reset guards when harness changes
    useEffect(() => {
        if (selectedHarn !== lastSelectedHarn.current) {
            timesFetched.current = false;
            lastSelectedHarn.current = selectedHarn;
        }
    }, [selectedHarn]);

    // Reset guards when buildKit changes
    useEffect(() => {
        if (buildKit && buildKit.REV !== lastBuildKitRev.current) {
            countsFetched.current = false;
            lastBuildKitRev.current = buildKit.REV;
        }
    }, [buildKit]);

    // Reset ALL guards when a time is submitted
    useEffect(() => {
        timesFetched.current = false;
        countsFetched.current = false;
    }, [refreshTrigger]);

    // Load build time estimate
    useEffect(() => {
        if (!buildKit || !harn) return;
        const harness = buildKit.harnesses.find((h) => h.partNum === harn);
        if (harness) {
            setBuildTimeEst({
                seconds: harness.buildTargetTime.seconds,
                formattedTime: harness.buildTargetTime.formattedTime,
            });
        }
    }, [buildKit, harn]);

    // Load chart times for selected harness
    useEffect(() => {
        if (!selectedHarn || timesFetched.current) return;
        timesFetched.current = true;
        async function loadTimes() {
            const result = await fetchTimes(selectedHarn);
            if (Array.isArray(result)) {
                setTimes(
                    result.map((t: LoggedTime) => ({
                        seconds: t.seconds,
                        formattedTime: t.formattedTime,
                    }))
                );
            }
        }
        loadTimes();
    }, [selectedHarn, harn, refreshTrigger]);

    // Load per-harness built counts
    useEffect(() => {
        if (!buildKit || countsFetched.current) return;
        countsFetched.current = true;
        async function loadCounts() {
            const counts: Record<string, number> = {};
            for (const harness of buildKit!.harnesses) {
                const result = await fetchTimes(harness.partNum);
                counts[harness.partNum] = Array.isArray(result) ? result.length : 0;
            }
            setHarnCounts(counts);
        }
        loadCounts();
    }, [buildKit, refreshTrigger]);

    function createInfoElement() {
        if (selectedUser) return <p>User: {selectedUser.name}</p>;
        return null;
    }

    function checkIsRunning() {
        return isRunning ? (
            <div className="indication-div-on"></div>
        ) : (
            <div className="indication-div-off"></div>
        );
    }

    function getProgress() {
        if (!buildKit) return null;
        return buildKit.harnesses.map((harness) => {
            const built = harnCounts[harness.partNum] ?? 0;
            return (
                <div key={harness.partNum} className="harn-progress-item">
                    <p>
                        {harness.partNum}:{" "}
                        <progress
                            className="progress-bar"
                            value={built}
                            max={harness.buildNumber}
                        />{" "}
                        {built}/{harness.buildNumber}
                    </p>
                </div>
            );
        });
    }

    return (
        <div>
            <div className="timer-info">
                <p className="timer">{displayTimer}</p>
                {checkIsRunning()}
            </div>
            <div className="progress">{getProgress()}</div>
            <div className="harn-build-chart-info">
                <p id="current-build-pn">Part #: {harn}</p>
                <p id="build-time-estimate">
                    Estimate: {Math.round(buildTimeEst.seconds / 60)} Minutes
                </p>
                {createInfoElement()}
            </div>
            <div className="build-chart">
                <AnalyticsChart
                    loggedTimes={times}
                    harnNumber={harn || ""}
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
