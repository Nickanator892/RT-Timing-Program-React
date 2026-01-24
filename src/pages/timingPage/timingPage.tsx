import { useState, useRef } from "react";
import "./timingPage.css";

function TimingPage() {
    const [displayTimer, setDisplayTimer] = useState("00:00:00");
    const [activeButton, setActiveButton] = useState<"start" | "pause" | "end" | "submit" | null>(
        null
    );
    const [err, setErr] = useState("");

    const intervalRef = useRef<number | null>(null);
    const startRef = useRef<number | null>(null);
    const elapsedRef = useRef(0);
    const [dbSuccess, setDbSuccess] = useState("Submit");

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
        setDbSuccess("Submit");
    }

    function pauseTimer() {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
            startRef.current = null;
            setErr("");
        }
    }

    function resetTimer() {
        if (displayTimer === "00:00:00") {
            return;
        }
        pauseTimer();
    }

    async function submitTime() {
        setDbSuccess("TimerStopCheck");
        if (isTimerRunning()) {
            setErr("Timer is still running");
            setDbSuccess("Submit");
            return;
        }
        setDbSuccess("TimerRunCheck");
        if (displayTimer === "00:00:00") {
            setErr("Timer is 00:00:00");
            setDbSuccess("Submit");
            return;
        } else {
            setDbSuccess("Fetching");
            const result = await execQuery("SELECT * FROM users", []);
            if (!result) {
                return;
            }
            console.log(result);
            elapsedRef.current = 0;
            setDisplayTimer("00:00:00");
            setDbSuccess("Success✅");
            setErr("");
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

    const execQuery = async (requestedQuery: string, params: unknown[] = []): Promise<unknown> => {
        try {
            const response = await fetch("http://localhost:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: requestedQuery, params }),
            });
            console.log(`RESPONSE: ${response}`);
            const data = await response.json();

            if (data.success === false) {
                setErr("Database Query Fail");
                setDbSuccess("Error❌");
                return;
            }
            const formattedData = JSON.stringify(data.result);
            return formattedData;
        } catch (err: any) {
            setErr("Server Not Running");
            setDbSuccess("Error❌");
        }
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
                <p id="timer">{displayTimer}</p>
                <p id="error-message">{err}</p>
                <div id="RT-logo">
                    <p id="RT-part-one">RT </p> <p id="RT-part-two">Technologies</p>
                </div>
            </div>
        </div>
    );
}

export default TimingPage;
