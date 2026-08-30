import "./analyticsPage.css";
import { useEffect, useState, useRef, useMemo } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import type { User } from "../../assets/types/UserType";
import AnalyticsChart from "../../common/analyticsChart/chart";
import useTimes from "../../hooks/useTimes";
import type { LoggedTime, HarnCount } from "../../hooks/useTimes";
import { useBuildKit } from "../../hooks/useBuildKit";
import { useSyncedTimer } from "../../hooks/useSyncedTimer";
import { parseTimestamp } from "../../assets/timeDistribution";
import {
    fetchScheduleWindow,
    computeScheduleStatus,
    type ScheduleWindow,
} from "../../assets/scheduleStatus";

interface analyticsPageProps {
    harn?: string;
}

declare const __APP_VERSION__: string;

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
        const [timerMode, _setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    const [harnCounts, setHarnCounts] = useState<Record<string, number>>({});
    const [times, setTimes] = useState<{ seconds: number; formattedTime: string }[]>([]);
    // undefined = not fetched yet, null = the run has no schedule dates
    const [scheduleWindow, setScheduleWindow] = useState<ScheduleWindow | null | undefined>(undefined);
    // Build-mode (timeTypeId 1) completions regardless of the viewed timer mode -
    // the schedule targets are build minutes, so the banner must not follow the
    // mode dropdown the way the progress bars do.
    const [buildCounts, setBuildCounts] = useState<Record<string, number>>({});
    const [secondaryBuilders, _setSecondaryBuilders] = useSharedState<{Id: Number, name: string}[]>("secondaryBuilders", [])

    const { fetchTimes, fetchAllTimes } = useTimes();
    const { buildKit } = useBuildKit();

    const countsFetched = useRef(false);
    const timesFetched = useRef(false);
    const lastSelectedHarn = useRef("");
    const lastBuildKitRev = useRef<number | null>(null);

    const lastTimerMode = useRef<number>(timerMode.id);

    // Reset guard when timerMode changes
    useEffect(() => {
        if (timerMode.id !== lastTimerMode.current) {
            timesFetched.current = false;
            countsFetched.current = false;
            lastTimerMode.current = timerMode.id;
        }
    }, [timerMode]);

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
// Load chart times for selected harness
    useEffect(() => {
        if (!selectedHarn || timesFetched.current) return;
        timesFetched.current = true;
        async function loadTimes() {
            console.log("Timer mode:", timerMode.header)
            const result = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(result)) {
                setTimes(
                    result.map((t: LoggedTime) => {
                        // workedSeconds sums the per-segment worked time, which
                        // is already pause-free and immune to gaps between
                        // segments (a build interrupted overnight and resumed
                        // the next morning). Never subtract pausedSeconds from
                        // it - that would deduct every pause twice.
                        // The span fallback covers rows written before this
                        // release, using the tolerant parser because the legacy
                        // dd/mm/yyyy format is not parseable by new Date().
                        let seconds = Math.round(Number(t.workedSeconds ?? 0));
                        if (!seconds) {
                            const start = parseTimestamp(t.startTime);
                            const end = parseTimestamp(t.endTime);
                            const gross =
                                start && end ? Math.round((end.getTime() - start.getTime()) / 1000) : 0;
                            seconds = Math.max(0, gross - Math.round(Number(t.pausedSeconds ?? 0)));
                        }
                        const h = Math.floor(seconds / 3600);
                        const m = Math.floor((seconds % 3600) / 60);
                        const s = seconds % 60;
                        const formattedTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                        return { seconds, formattedTime };
                    })
                );
            }
        }
        loadTimes();
    }, [selectedHarn, harn, refreshTrigger, timerMode]);

    // Load per-harness built counts
    useEffect(() => {
        if (!buildKit || countsFetched.current) return;
        countsFetched.current = true;
        async function loadCounts() {
            console.log("Timer mode:", timerMode.header)
            const allTimes = await fetchAllTimes(buildKit?.REV, timerMode.id);
            const counts: Record<string, number> = {};
            for (const harness of buildKit!.harnesses) {
                const match = allTimes.find((t: HarnCount) => t.harnNumber === harness.partNum);
                counts[harness.partNum] = match ? match.count : 0;
            }
            setHarnCounts(counts);

            const buildTimes =
                timerMode.id === 1 ? allTimes : await fetchAllTimes(buildKit?.REV, 1);
            const forSchedule: Record<string, number> = {};
            for (const harness of buildKit!.harnesses) {
                const match = buildTimes.find((t: HarnCount) => t.harnNumber === harness.partNum);
                forSchedule[harness.partNum] = match ? match.count : 0;
            }
            setBuildCounts(forSchedule);
        }
        loadCounts();
    }, [buildKit, refreshTrigger, timerMode]);

    // Load the run's schedule window (pricing program's target dates)
    useEffect(() => {
        if (!buildKit) return;
        let cancelled = false;
        fetchScheduleWindow(buildKit.REV).then((win) => {
            if (!cancelled) setScheduleWindow(win);
        });
        return () => {
            cancelled = true;
        };
    }, [buildKit?.REV]);

    // displayTimer ticks once a second, keeping "expected by now" current.
    const scheduleStatus = useMemo(() => {
        if (!buildKit || !scheduleWindow) return null;
        return computeScheduleStatus(buildKit, buildCounts, scheduleWindow);
    }, [buildKit, buildCounts, scheduleWindow, displayTimer]);

    function renderScheduleStatus() {
        if (!buildKit || scheduleWindow === undefined) return null;
        if (scheduleWindow === null) {
            return (
                <div className="schedule-status schedule-none">
                    <p className="schedule-delta">NO SCHEDULE DATES</p>
                </div>
            );
        }
        if (!scheduleStatus) return null;
        const onPace = Math.abs(scheduleStatus.deltaMin) < 30;
        const ahead = scheduleStatus.deltaMin >= 0;
        const stateClass = onPace ? "schedule-onpace" : ahead ? "schedule-ahead" : "schedule-behind";
        return (
            <div className={`schedule-status ${stateClass}`}>
                <p className="schedule-day">
                    SCHEDULE: DAY {scheduleStatus.workdayOf} / {scheduleStatus.totalWorkdays}
                    {scheduleWindow.anchored ? " (FROM FIRST BUILD)" : ""}
                    {scheduleStatus.pastEnd ? " (PAST END DATE)" : ""}
                </p>
                <p className="schedule-delta">
                    {onPace
                        ? "ON PACE"
                        : `${ahead ? "AHEAD" : "BEHIND"} ${(Math.abs(scheduleStatus.deltaMin) / 60).toFixed(1)} h`}
                </p>
                <p className="schedule-detail">
                    {(scheduleStatus.earnedMin / 60).toFixed(1)} h done ·{" "}
                    {(scheduleStatus.expectedMin / 60).toFixed(1)} h expected of{" "}
                    {(scheduleStatus.plannedMin / 60).toFixed(1)} h planned
                </p>
            </div>
        );
    }

    function createInfoElement() {
        if (selectedUser) return (
            <div>
                <p>Primary: {selectedUser.name}</p>
                <p>Secondaries: {secondaryBuilders.map((builder) => {return (<li>{builder.name}</li>)})}</p>
            </div>

    );
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
                {renderScheduleStatus()}
                <div className="progress-list">{getProgress()}</div>
                <div className="harn-build-chart-info">
                    <p id="current-build-pn">Part #: {harn}</p>
                    <p id="build-time-estimate">
                        Estimate: ~{Math.round(buildTimeEst.seconds / 60)} Minutes
                    </p>
                    {createInfoElement()}
                    <p id="version-tag">App Version: v{__APP_VERSION__}</p>
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
