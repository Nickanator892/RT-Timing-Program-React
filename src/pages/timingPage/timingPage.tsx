import "./timingPage.css";
import { useState, useEffect, useRef } from "react";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import useTimes, { type LoggedTime } from "../../hooks/useTimes";
import { useBuildKit } from "../../hooks/useBuildKit";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";
import TimerModeDropdown from "../../common/timerModeDropdown/timerModeDropdown";
import TimeSetupButton from "../../common/buttons/timeSetupButton/timeSetupButton";
import TimeTeardownButton from "../../common/buttons/timeTeardownButton/timeTeardownButton";
import TimeBuildButton from "../../common/buttons/timeBuildButton/timeBuildButton";
import type { PauseReason } from "../../assets/types/pauseReasonType";
import type { User } from "../../assets/types/UserType";
import { useSyncedTimer } from "../../hooks/useSyncedTimer";
import CloseButton from "../../common/buttons/closeButton/closeButton";
import RTLogo from "../../components/RTLogo/RTLogo";
import { writeDistributedTimes } from "../../assets/timeDistribution";

type timingPageProps = {
    activeButton: "start" | "pause" | "end" | "submit" | null;
    setActiveButton: (value: "start" | "pause" | "end" | "submit" | null) => void;
    err: string;
    setErr: (value: string) => void;
    pauseStart: string | null;
    setPauseStart: React.Dispatch<React.SetStateAction<string | null>>;
};

function TimingPage({
    activeButton,
    setActiveButton,
    err,
    setErr,
    pauseStart,
    setPauseStart,
}: timingPageProps) {
    const { buildKit } = useBuildKit();
    const [dbSuccess, setDbSuccess] = useState("Submit");
    const [harnBuilt, setHarnBuilt] = useState(0);
    const [harnTotal, setHarnTotal] = useState(0);
    const [isRunning, setIsRunning] = useSharedState<boolean>("isRunning", false);
    const [timerDone, setTimerDone] = useSharedState<boolean>("timerDone", true);
    const displayTimer = useSyncedTimer();
    const [startTime, setStartTime] = useSharedState<string>("startTime", "");
    const [endTime, setEndTime] = useSharedState<string>("endTime", "");
    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [disableButtons, setDisabledButtons] = useState<boolean>(false);
    const [disableSubmit, setDisableSubmit] = useState<boolean>(true);
    const [refreshTrigger, setRefreshTrigger] = useSharedState<number>("refreshTrigger", 0);
    const [currentBuildId, setCurrentBuildId] = useSharedState<number | boolean>(
        "currentBuildId",
        0
    );
    const [selectedUser, _setSelectedUser] = useSharedState<User | undefined>(
        "selectedUser",
        undefined
    );
    const [sharedPauseReason, _setSharedPauseReason] = useSharedState<PauseReason | undefined>(
        "pauseReason",
        undefined
    );
    const [secondaryBuilders, _setSecondaryBuilders] = useSharedState<{Id: Number, name: string}[]>("secondaryBuilders", [])
    const [timerMode, _setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    const [currentSegmentStart, setCurrentSegmentStart] = useSharedState<string>("currentSegmentStart", "");
    // Batch mode: one timed window covers `batchUnits` physical units of the PN
    // (e.g. stripping every cable for all harnesses at once). No rows are
    // written at start - submit slices the window across the units.
    const [batchMode, setBatchMode] = useState<boolean>(false);
    const [batchUnits, setBatchUnits] = useState<number>(1);
    const batchPauses = useRef<{ start: string; end: string; reasonId: string | undefined }[]>([]);
    const { writeTime, fetchTimes } = useTimes();
    const nav = useNavigate();

    const timesFetched = useRef(false);
    const lastSelectedHarn = useRef("");

    const isFirstRender = useRef(true);
const prevSecondaryBuilders = useRef(secondaryBuilders);

useEffect(() => {
    // Skip on first render or if timer isn't running
    if (isFirstRender.current) {
        isFirstRender.current = false;
        prevSecondaryBuilders.current = secondaryBuilders;
        return;
    }

    // Only react if builders actually changed and a build is in progress
    if (timerDone) return;
    if (secondaryBuilders.length === prevSecondaryBuilders.current.length) return;
    prevSecondaryBuilders.current = secondaryBuilders;

    // Batch runs have no rows to segment yet - the final builder count is
    // recorded when submit writes the distributed rows.
    if (batchMode) return;

    // handleBuilderChange - use HARNBUILDSEGMENTS instead of HARNBUILDTIMES
    async function handleBuilderChange() {
        window.electron.timerPause();
        setIsRunning(false);

        const segmentEnd = formatTimestamp(new Date().toISOString());

        // Close current segment
        await execQuery(
            "UPDATE HARNBUILDSEGMENTS SET endTime=? WHERE buildId=? AND startTime=?",
            [segmentEnd, currentBuildId, currentSegmentStart]
        );

        // Open new segment
        const newSegmentStart = formatTimestamp(new Date().toISOString());
        setCurrentSegmentStart(newSegmentStart);
        await execQuery(
            "INSERT INTO HARNBUILDSEGMENTS (buildId, startTime, endTime, numberOfBuilders) VALUES(?, ?, ?, ?)",
            [currentBuildId, newSegmentStart, "", secondaryBuilders.length + 1]
        );

        // Update HARNBUILDTIMES numberOfBuilders to reflect current count
        await execQuery(
            "UPDATE HARNBUILDTIMES SET numberOfBuilders=? WHERE buildId=?",
            [secondaryBuilders.length + 1, currentBuildId]
        );

        // Refresh secondary builders
        await execQuery("DELETE FROM SECONDARYBUILDERS WHERE buildId=?", [currentBuildId]);
        if (secondaryBuilders.length > 0) {
            for (const builder of secondaryBuilders) {
                await execQuery(
                    "INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)",
                    [currentBuildId, builder.Id]
                );
            }
        }

        window.electron.timerStart();
        setIsRunning(true);
    }

    handleBuilderChange();
}, [secondaryBuilders, currentBuildId, currentSegmentStart, selectedHarn, buildKit, selectedUser, timerMode, timerDone, batchMode]);

    // Default the batch unit count to the PN's qty-to-build.
    useEffect(() => {
        const harness = buildKit?.harnesses.find((h) => h.partNum === selectedHarn);
        if (harness && harness.buildNumber > 0) setBatchUnits(harness.buildNumber);
    }, [selectedHarn, buildKit]);

    useEffect(() => {
        if (selectedHarn !== lastSelectedHarn.current) {
            timesFetched.current = false;
            lastSelectedHarn.current = selectedHarn;
        }
    }, [selectedHarn]);

    useEffect(() => {
        if (!selectedHarn || timesFetched.current) return;
        timesFetched.current = true;
        async function loadBuiltCount() {
            const result = await fetchTimes(selectedHarn, timerMode.id);
            if (buildKit) {
                const harness = buildKit.harnesses.find((h) => h.partNum === selectedHarn);
                if (harness) setHarnTotal(harness.buildNumber);
            }
            if (Array.isArray(result)) {
                setHarnBuilt(result.length);
            }
        }
        loadBuiltCount();
    }, [selectedHarn, buildKit]);

    // Refresh counts when a time is submitted
    useEffect(() => {
        timesFetched.current = false;
    }, [refreshTrigger]);

    const execQuery = async (requestedQuery: string, params: unknown[] = []): Promise<any> => {
        try {
            const response = await fetch("http://localhost:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: requestedQuery, params }),
            });
            const data = await response.json();

            if (data.success === false) return false;
            return data;
        } catch (err: any) {
            console.log(err);
            return false;
        }
    };

    async function insertPause() {
        const pauseEnd = formatTimestamp(new Date().toISOString());
        if (sharedPauseReason) {
            try {
                await execQuery(
                    "INSERT INTO HARNBUILDTIMES (buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    [currentBuildId, pauseStart, pauseEnd, selectedHarn, buildKit?.REV, selectedUser?.Id, 4, sharedPauseReason.Id]
                );
            } catch (err: unknown) {
                throw new Error("Error");
            }
        }
    }

    // Local time in "YYYY-MM-DD HH:mm:ss": sorts correctly as text (ORDER BY
    // startTime) and parses with new Date() (the old dd/mm/yyyy-HH:mm:ss did
    // neither - analytics durations came back NaN).
    function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
    }

    async function startTimer() {
        if (isRunning) return;
        window.electron.timerStart();
        if (pauseStart) {
            if (batchMode && !timerDone) {
                // No build row exists yet - queue the pause; submit attaches it
                // to the batch's first build row.
                batchPauses.current.push({
                    start: pauseStart,
                    end: formatTimestamp(new Date().toISOString()),
                    reasonId: sharedPauseReason?.Id,
                });
                setPauseStart(null);
            } else {
                insertPause();
            }
        }

        if (timerDone) {
            const startTime = formatTimestamp(new Date().toISOString());
            setStartTime(startTime);
            setCurrentSegmentStart(startTime);
            setTimerDone(false);
            setIsRunning(true);
            setErr("");
            setDbSuccess("Submit");

            // Batch runs write nothing at start - all rows are created at
            // submit, when the total window and unit count are known.
            if (batchMode) return;

            // The insert's own lastID - a MAX(buildId) round trip races when two
            // stations start builds at the same time.
            const insertData = await execQuery("INSERT INTO HARNBUILDS (harnNumber) VALUES(?)", [selectedHarn]);
            const buildId = Number(insertData?.result?.lastID ?? 0);
            setCurrentBuildId(buildId);

            // One row in HARNBUILDTIMES — no startTime/endTime here anymore
            await execQuery(
                "INSERT INTO HARNBUILDTIMES (buildId, harnNumber, REV, builderId, timeTypeId, numberOfBuilders) VALUES(?, ?, ?, ?, ?, ?)",
                [buildId, selectedHarn, buildKit?.REV, selectedUser?.Id, timerMode.id, secondaryBuilders.length + 1]
            );

            // First segment
            await execQuery(
                "INSERT INTO HARNBUILDSEGMENTS (buildId, startTime, endTime, numberOfBuilders) VALUES(?, ?, ?, ?)",
                [buildId, startTime, "", secondaryBuilders.length + 1]
            );

            if (secondaryBuilders.length > 0) {
                for (const builder of secondaryBuilders) {
                    await execQuery(
                        "INSERT INTO SECONDARYBUILDERS (buildId, builderId) VALUES (?, ?)",
                        [buildId, builder.Id]
                    );
                }
            }
            return;
        }
        setIsRunning(true);
        setErr("");
        setDbSuccess("Submit");
    }

    function pauseTimer() {
        window.electron.timerPause();
        const pauseStartTime = formatTimestamp(new Date().toISOString())
        setPauseStart(pauseStartTime);
        setEndTime(new Date().toISOString());
        setIsRunning(false);
        setTimeout(() => {
            nav("/pause-reason-page");
        }, 50);
    }

    function resetTimer() {
        if (displayTimer === "00:00:00") return;
        window.electron.timerPause();
        if (!timerDone) {
            const localEndTime = formatTimestamp(new Date().toISOString())
            setEndTime(localEndTime);
        }
        setIsRunning(false);
        setDisableSubmit(false);
    }

    /** Batch submit: slice the timed window across the unit count. */
    async function submitBatch() {
        const units = Math.max(1, Math.floor(batchUnits));
        setDbSuccess("Saving batch...");
        try {
            const startMs = new Date(startTime).getTime();
            const endMs = new Date(endTime).getTime();
            if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
                throw new Error("Bad time window - end the timer before submitting");
            }
            const buildIds = await writeDistributedTimes({
                harnNumber: selectedHarn,
                rev: buildKit?.REV,
                builderId: selectedUser?.Id,
                timeTypeId: timerMode.id,
                units,
                startMs,
                endMs,
                numberOfBuilders: secondaryBuilders.length + 1,
                secondaryBuilderIds: secondaryBuilders.map((b) => Number(b.Id)),
            });
            for (const pause of batchPauses.current) {
                await execQuery(
                    "INSERT INTO HARNBUILDTIMES (buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    [buildIds[0], pause.start, pause.end, selectedHarn, buildKit?.REV, selectedUser?.Id, 4, pause.reasonId]
                );
            }
            batchPauses.current = [];

            const updatedTimes = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }
            window.electron.timerReset();
            setRefreshTrigger((prev) => prev + 1);
            setTimerDone(true);
            setDbSuccess(`${units} units ✅`);
            setErr("");
            setPauseStart(null);
        } catch (e: any) {
            setErr(String(e?.message ?? e));
            setDbSuccess("Submit");
        }
    }

    async function submitTime() {
        setDbSuccess("Checking...");
        if (isRunning) {
            setErr("Timer is still running");
            setDbSuccess("Submit");
            return;
        }
        const currentTime = displayTimer;
        if (currentTime === "00:00:00") {
            setErr("Timer is 00:00:00");
            setDbSuccess("Submit");
            return;
        }
        if (batchMode) {
            await submitBatch();
            return;
        }
        setDbSuccess("Fetching...");
        try {
            const timeObject: Partial<LoggedTime> = {
                startTime: startTime,
                endTime: endTime,
                harnNumber: selectedHarn,
            };
            if (typeof currentBuildId == "number") {
                const result = await writeTime(timeObject, currentBuildId, selectedUser?.Id);
                if (!result) {
                    return;
                }
            }

            const updatedTimes = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }

            window.electron.timerReset();
            setRefreshTrigger((prev) => prev + 1); // ← triggers analytics to refresh
            setTimerDone(true);
            setDbSuccess("Success✅");
            setErr("");
            setPauseStart(null);

            if (harnBuilt + 1 >= harnTotal) {
                setDbSuccess("ALL BUILT ✅");
            }
        } catch (e: any) {
            setErr(e);
            setDbSuccess("Submit");
        }
    }

    const handleButtonClick = (button: "start" | "pause" | "end" | "submit") => {
        setActiveButton(button);
        if (button === "start") startTimer();
        if (button === "pause") pauseTimer();
        if (button === "end") resetTimer();
        if (button === "submit") submitTime();
    };


    return (
        <div className="timing-page">
            <div id="buttons">
                <button
                    id="start-button"
                    className={activeButton === "start" ? "pressed" : ""}
                    onClick={() => handleButtonClick("start")}
                    disabled={disableButtons}
                >
                    {isRunning ? "Running" : displayTimer === "00:00:00" ? "Start" : "Resume"}
                </button>
                <button
                    id="pause-button"
                    className={activeButton === "pause" ? "pressed" : ""}
                    onClick={() => handleButtonClick("pause")}
                    disabled={!isRunning || disableButtons}
                >
                    Pause
                </button>
                <button
                    id="end-button"
                    className={activeButton === "end" ? "pressed" : ""}
                    onClick={() => {
                        handleButtonClick("end");
                        setDisabledButtons(true);
                        setTimeout(() => {
                            setDisabledButtons(false);
                        }, 100);
                    }}
                    disabled={disableButtons}
                >
                    End
                </button>
                <hr id="colour-indicator" />
                <button
                    id="submit-time-button"
                    className={activeButton === "submit" ? "pressed" : ""}
                    onClick={() => handleButtonClick("submit")}
                    disabled={disableButtons || disableSubmit}
                >
                    {dbSuccess}
                </button>
            </div>
            <div id="error-timer">
                <div id="nav-buttons">
                    <TimerButton />
                    <SettingsButton />
                    <ChooseHarnessButton />
                    <ChooseKitButton />
                </div>
                <p id="timer">{displayTimer}</p>

                <div className="harn-info-and-close-button">
                    <div className="harn-build-info">
                        <p id="current-build-pn">Part #: {selectedHarn}</p>
                        <p id="timer-mode">Timer Mode: {timerMode.header}</p>
                    </div>
                    <TimerModeDropdown/>
                    <div className="batch-controls">
                        <label className="batch-toggle">
                            <input
                                type="checkbox"
                                checked={batchMode}
                                disabled={!timerDone}
                                onChange={(e) => setBatchMode(e.target.checked)}
                            />
                            Batch: one time across all units
                        </label>
                        {batchMode && (
                            <label className="batch-units">
                                Units:
                                <input
                                    type="number"
                                    min={1}
                                    value={batchUnits}
                                    disabled={!timerDone}
                                    onChange={(e) => setBatchUnits(Number(e.target.value))}
                                />
                            </label>
                        )}
                    </div>
                    <CloseButton />
                </div>

                <p id="error-message">{err}</p>
                <RTLogo />
            </div>
        </div>
    );
}

export default TimingPage;
