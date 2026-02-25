import "./timingPage.css";
import { useState, useEffect, useRef } from "react";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import useTimes, { type LoggedTime } from "../../hooks/loggedTimesHook";
import { useBuildKit } from "../../hooks/useBuildKit";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";

type timingPageProps = {
    activeButton: "start" | "pause" | "end" | "submit" | null;
    setActiveButton: (value: "start" | "pause" | "end" | "submit" | null) => void;
    err: string;
    setErr: (value: string) => void;
};

function TimingPage({ activeButton, setActiveButton, err, setErr }: timingPageProps) {
    const { buildKit } = useBuildKit();
    const [dbSuccess, setDbSuccess] = useState("Submit");
    const [harnBuilt, setHarnBuilt] = useState(0);
    const [harnTotal, setHarnTotal] = useState(0);
    const [isRunning, setIsRunning] = useSharedState<boolean>("isRunning", false);
    const [displayTimer] = useSharedState<string>("displayTimer", "00:00:00");
    const [startTime, setStartTime] = useSharedState<string>("startTime", "");
    const [endTime, setEndTime] = useSharedState<string>("endTime", "");
    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [refreshTrigger, setRefreshTrigger] = useSharedState<number>("refreshTrigger", 0);
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

    function startTimer() {
        if (isRunning) return;
        window.electron.timerStart();
        setIsRunning(true);
        setStartTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
        setErr("");
        setDbSuccess("Submit");
    }

    function pauseTimer() {
        window.electron.timerPause();
        setEndTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
        setIsRunning(false);
        setTimeout(() => {
            nav("/pause-reason-page");
        }, 50);
    }

    function resetTimer() {
        if (displayTimer === "00:00:00") return;
        window.electron.timerPause();
        setEndTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
        setIsRunning(false);
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
            if (buildKit) {
                const result = await writeTime(timeObject, buildKit?.REV);
                if (!result) return;
            }



            // Refresh counts locally
            const updatedTimes = await fetchTimes(selectedHarn);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }

            window.electron.timerReset();
            setRefreshTrigger((prev) => prev + 1); // ← triggers analytics to refresh
            setDbSuccess("Success✅");
            setErr("");

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
                >
                    {isRunning ? "Running" : displayTimer === "00:00:00" ? "Start" : "Resume"}
                </button>
                <button
                    id="pause-button"
                    className={activeButton === "pause" ? "pressed" : ""}
                    onClick={() => handleButtonClick("pause")}
                    disabled={!isRunning}
                >
                    Pause
                </button>
                <button
                    id="end-button"
                    className={activeButton === "end" ? "pressed" : ""}
                    onClick={() => handleButtonClick("end")}
                >
                    End
                </button>
                <hr id="colour-indicator" />
                <button
                    id="submit-time-button"
                    className={activeButton === "submit" ? "pressed" : ""}
                    onClick={() => handleButtonClick("submit")}
                >
                    {dbSuccess}
                </button>
            </div>
            <div id="error-timer">
                <div id="nav-buttons">
                    <TimerButton />
                    <SettingsButton />
                    <ChooseHarnessButton />
                    <ChooseKitButton/>
                </div>
                <p id="timer">{displayTimer}</p>
                <div className="harn-build-info">
                    <p id="current-build-pn">Part #: {selectedHarn}</p>
                    <p id="to-build-number">{harnLeft} Left</p>
                    <p id="harn-build">{harnBuilt} Built</p>
                    <p id="total-build">Total: {harnTotal}</p>
                </div>
                <p id="error-message">{err}</p>
                <div id="RT-logo">
                    <p id="RT-part-one">RT </p>
                    <p id="RT-part-two">Technologies</p>
                </div>
            </div>
        </div>
    );
}

export default TimingPage;
