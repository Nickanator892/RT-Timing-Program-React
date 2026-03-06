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
import type { PauseReason } from "../../assets/types/pauseReasonType";
import type { User } from "../../assets/types/UserType";
import { useSyncedTimer } from "../../hooks/useSyncedTimer";
import CloseButton from "../../common/buttons/closeButton/closeButton";
import RTLogo from "../../components/RTLogo/RTLogo";

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
    const { writeTime, fetchTimes } = useTimes();
    const nav = useNavigate();

    const timesFetched = useRef(false);
    const lastSelectedHarn = useRef("");

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
            const result = await fetchTimes(selectedHarn);
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

    async function getBuildId() {
        const data = await execQuery("SELECT MAX(buildId) as maxId FROM HARNBUILDTIMES");
        const buildId = Number(data["result"]["0"].maxId ?? 0);
        setCurrentBuildId(buildId);
    }

    async function insertPause() {
        const pauseEnd = new Date().toLocaleTimeString("en-GB", { hour12: false });
        if (sharedPauseReason) {
            try {
                await execQuery(
                    "INSERT INTO HARNBUILDPAUSEHISTORY (buildId, pauseId, pauseStart, pauseEnd) VALUES(?, ?, ?, ?)",
                    [currentBuildId, sharedPauseReason.Id, pauseStart, pauseEnd]
                );
            } catch (err: unknown) {
                throw new Error("Error");
            }
        }
    }

    async function startTimer() {
        if (isRunning) return;
        window.electron.timerStart();
        if (pauseStart) {
            insertPause();
        }

        if (timerDone) {
            setStartTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
            setTimerDone(false);
            setIsRunning(true);
            setErr("");
            setDbSuccess("Submit");
            await execQuery(
                "INSERT INTO HARNBUILDTIMES (startTime, endTime, seconds, formattedTime, harnNumber, dateBuilt, REV, builderId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                ["", "", "", "", "", "", "", selectedUser?.Id]
            );
            getBuildId();
            return;
        }
        setIsRunning(true);
        setErr("");
        setDbSuccess("Submit");
    }

    function pauseTimer() {
        window.electron.timerPause();
        const newDate = new Date().toLocaleTimeString("en-GB", { hour12: false });
        setPauseStart(newDate);
        setEndTime(newDate);
        setIsRunning(false);
        setTimeout(() => {
            nav("/pause-reason-page");
        }, 50);
    }

    function resetTimer() {
        if (displayTimer === "00:00:00") return;
        window.electron.timerPause();
        if (!timerDone) {
            setEndTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
        }
        setIsRunning(false);
        setDisableSubmit(false);
    }

    function calculateSeconds(timeString: string): number {
        if (!timeString || typeof timeString !== "string") return 0;
        try {
            const [hours, minutes, seconds] = timeString.split(":").map(Number);
            return hours * 3600 + minutes * 60 + seconds;
        } catch (error) {
            console.error("Error parsing time string:", timeString, error);
            return 0;
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
        setDbSuccess("Fetching...");
        try {
            const timeObject: LoggedTime = {
                startTime: startTime,
                endTime: endTime,
                seconds: calculateSeconds(currentTime),
                formattedTime: currentTime,
                harnNumber: selectedHarn,
                dateBuilt: new Date().toISOString().split("T")[0],
            };
            if (typeof currentBuildId == "number") {
                const result = await writeTime(timeObject, currentBuildId, selectedUser?.Id);
                if (!result) {
                    return;
                }
            }

            // Refresh counts locally
            const updatedTimes = await fetchTimes(selectedHarn);
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

    const harnLeft = harnTotal - harnBuilt;

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
                        <p id="to-build-number">{harnLeft} Left</p>
                        <p id="harn-build">{harnBuilt} Built</p>
                        <p id="total-build">Total: {harnTotal}</p>
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
