import "./analyticsPage.css";
import { useEffect, useState, useRef } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import type { User } from "../../assets/types/UserType";
import AnalyticsChart from "../../common/analyticsChart/chart";
import useTimes from "../../hooks/useTimes";
import type { LoggedTime, HarnCount } from "../../hooks/useTimes";
import { useBuildKit } from "../../hooks/useBuildKit";
import { useSyncedTimer } from "../../hooks/useSyncedTimer";

interface analyticsPageProps {
    harn?: string;
}

function AnalyticsPage({ harn }: analyticsPageProps) {
    const displayTimer = useSyncedTimer();
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

    const { fetchTimes, fetchAllTimes } = useTimes();
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
            const allTimes = await fetchAllTimes(buildKit?.REV);
            const counts: Record<string, number> = {};
            for (const harness of buildKit!.harnesses) {
                const match = allTimes.find((t: HarnCount) => t.harnNumber === harness.partNum);
                counts[harness.partNum] = match ? match.count : 0;
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
                    <span className="harn-part-num">{harness.partNum}:</span>
                    <progress className="progress-bar" value={built} max={harness.buildNumber} />
                    <span className="harn-count">
                        {built}/{harness.buildNumber}
                    </span>
                </div>
            );
        });
    }

    return (
        <div className="analytics-root">
            <div className="left-col">
                <div className="progress-list">{getProgress()}</div>
                <div className="harn-build-chart-info">
                    <p id="current-build-pn">Part #: {harn}</p>
                    <p id="build-time-estimate">
                        Estimate: ~{Math.round(buildTimeEst.seconds / 60)} Minutes
                    </p>
                    {createInfoElement()}
                </div>
            </div>

            <div className="right-col">
                <div className="top-bar">
                    <div className="timer-section">
                        <p className="timer">{displayTimer}</p>
                        {checkIsRunning()}
                    </div>
                    <div id="RT-logo">
                        <span id="RT-part-one">RT </span>
                        <span id="RT-part-two">Technologies</span>
                    </div>
                </div>
                <div className="chart-area">
                    <AnalyticsChart
                        loggedTimes={times}
                        harnNumber={harn || ""}
                        buildNumber={30}
                        buildTimeEst={buildTimeEst}
                        currentTimeSeconds={displayTimer}
                    />
                </div>
            </div>
        </div>
    );
}

export default AnalyticsPage;
