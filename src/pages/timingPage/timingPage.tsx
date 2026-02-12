import "./timingPage.css";
import { useState, useEffect } from "react";
import SettingsButton from "../../common/settingsButton/settingsButton";
import TimerButton from "../../common/timerButton/timerButton";
import { useNavigate } from "react-router-dom";
import type { PauseReason } from "../../assets/types/pauseReasonType";
import type { User } from "../../assets/types/UserType";
import { useSharedState } from "../../hooks/useSharedState";
import ChooseHarnessButton from "../../common/chooseHarnessButton/chooseHarnessButton";
import useTimes, { type LoggedTime } from "../../hooks/loggedTimesHook";

type timingPageProps = {
    displayTimer: string;
    setDisplayTimer: React.Dispatch<React.SetStateAction<string>>;
    activeButton: "start" | "pause" | "end" | "submit" | null;
    setActiveButton: React.Dispatch<
        React.SetStateAction<"start" | "pause" | "end" | "submit" | null>
    >;
    pauseReason: PauseReason[];
    err: string;
    setErr: React.Dispatch<React.SetStateAction<string>>;
    intervalRef: React.MutableRefObject<number | null>;
    startRef: React.MutableRefObject<number | null>;
    elapsedRef: React.MutableRefObject<number>;
    selectedUser: User | undefined;
};

function TimingPage({
    displayTimer,
    setDisplayTimer,
    activeButton,
    setActiveButton,
    pauseReason,
    err,
    setErr,
    intervalRef,
    startRef,
    elapsedRef,
    selectedUser,
}: timingPageProps) {
    const [dbSuccess, setDbSuccess] = useState("Submit");
    const [harnPn, setHarnPn] = useState("");
    const [harnLeft, setHarnLeft] = useState(4);
    const [harnBuilt, setHarnBuilt] = useState(26);
    const [isRunning, setIsRunning] = useSharedState<boolean>("isRunning", false);
    const [startTime, setStartTime] = useSharedState<string>("startTime", "")
    const [endTime, setEndTime] = useSharedState<string>("endTime", "")
    const [selectedHarn] = useSharedState<string>("selectedHarn", "")
    const { writeTime, fetchTimes } = useTimes()
    const nav = useNavigate();

    console.log("Selected User:", selectedUser);

    function startTimer() {
        if (intervalRef.current) return;

        const start = performance.now() - elapsedRef.current;
        startRef.current = start;

        intervalRef.current = window.setInterval(() => {
            const now = performance.now();
            const newElapsed = now - (startRef.current ?? now);
            elapsedRef.current = newElapsed;

            // Format HH:MM:SS
            const totalSeconds = Math.floor(newElapsed / 1000);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;

            setDisplayTimer(
                `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
                    seconds
                ).padStart(2, "0")}`
            );
        }, 100);
        setErr("");
        setIsRunning(true)
        setStartTime(new Date().toLocaleTimeString('en-GB', { hour12: false }))
        setDbSuccess("Submit");
    }

    function pauseTimer() {
        if (intervalRef.current) {
            setEndTime(new Date().toLocaleTimeString('en-GB', { hour12: false }))
            clearInterval(intervalRef.current);
            intervalRef.current = null;
            startRef.current = null;
            setIsRunning(false)
            nav("/pause-reason-page");
        }
    }

    function resetTimer() {
        if (displayTimer === "00:00:00") {
            return;
        }
        if (intervalRef.current) {
            setEndTime(new Date().toLocaleTimeString('en-GB', { hour12: false }))
            clearInterval(intervalRef.current);
            intervalRef.current = null;
            startRef.current = null;
            setIsRunning(false)
        }
    }

    function calculateSeconds(timeString: string): number {
        if (!timeString || typeof timeString !== 'string') {
            return 0;
        }
        
        try {
            const [hours, minutes, seconds] = timeString.split(':').map(Number);
            return (hours * 3600) + (minutes * 60) + seconds;
        } catch (error) {
            console.error('Error parsing time string:', timeString, error);
            return 0;
        }
    }

    useEffect(() => {
        if (selectedHarn) {
            fetchTimes(selectedHarn);
        }
    }, [selectedHarn]);

    async function submitTime() {
        setDbSuccess("TimerStopCheck...");
        if (isTimerRunning()) {
            setErr("Timer is still running");
            setDbSuccess("Submit");
            return;
        }
        setDbSuccess("TimerRunCheck...");
        if (displayTimer === "00:00:00") {
            setErr("Timer is 00:00:00");
            setDbSuccess("Submit");
            return;
        } else {
            setDbSuccess("Fetching...");
            let result = undefined
            try {
                const timeObject: LoggedTime = {
                    startTime: startTime,
                    endTime: endTime,
                    seconds: calculateSeconds(displayTimer),
                    formattedTime: displayTimer,
                    harnNumber: selectedHarn,
                    dateBuilt: (new Date().toISOString().split('T')[0])
                }
                result = await writeTime(timeObject);
            } catch (err: any) {
                setErr(err)
            }


            if (!result) {
                return;
            }

            if (selectedHarn) {
                await fetchTimes(selectedHarn);
            }
            elapsedRef.current = 0;
            setDisplayTimer("00:00:00");
            setDbSuccess("Success✅");
            setHarnBuilt((prev) => prev + 1);
            setHarnLeft((prev) => prev - 1);
            setErr("");
            if (harnLeft == 1) {
                setDisplayTimer("ALL BUILT");
            }
        }
    }

    function isTimerRunning() {
        return intervalRef.current !== null;
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
                >
                    {elapsedRef.current === 0 ? "Start" : "Resume"}
                </button>

                <button
                    id="pause-button"
                    className={activeButton === "pause" ? "pressed" : ""}
                    onClick={() => handleButtonClick("pause")}
                    disabled={!isTimerRunning()}
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
                    className={activeButton === "end" ? "pressed" : ""}
                    onClick={() => handleButtonClick("submit")}
                >
                    {dbSuccess}
                </button>
            </div>

            <div id="error-timer">
                <div id="nav-buttons">
                    <TimerButton />
                    <SettingsButton />
                    <ChooseHarnessButton/>
                </div>
                <p id="timer">{displayTimer}</p>

                <div className="harn-build-info">
                    <p id="current-build-pn">Part #: {harnPn}</p>
                    <p id="to-build-number">{harnLeft} Left</p>
                    <p id="harn-build">{harnBuilt} Built</p>
                    <p id="total-build">Total: {harnBuilt + harnLeft}</p>
                </div>

                <p id="error-message">{err}</p>
                <div id="RT-logo">
                    <p id="RT-part-one">RT </p> <p id="RT-part-two">Technologies</p>
                </div>
            </div>
        </div>
    );
}

export default TimingPage;
