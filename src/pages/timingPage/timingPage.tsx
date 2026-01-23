import { useState, useRef } from "react";
import "./timingPage.css";

function TimingPage() {
    const [displayTimer, setDisplayTimer] = useState("00:00:00");
    const [activeButton, setActiveButton] = useState<"start" | "pause" | "end" | null>(null);

    const intervalRef = useRef<number | null>(null);
    const startRef = useRef<number | null>(null); // timestamp of current run
    const elapsedRef = useRef(0); // total elapsed ms

    // Start or resume the timer
    function startTimer() {
        if (intervalRef.current) return; // already running

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
        }, 100); // update every 100ms
    }

    // Pause the timer
    function pauseTimer() {
        if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
            startRef.current = null; // stop current run
        }
    }

    // Reset the timer
    function resetTimer() {
        runQuery("SELECT * FROM users");
        pauseTimer();
        elapsedRef.current = 0;
        setDisplayTimer("00:00:00");
    }

    // Check if timer is running
    function isTimerRunning() {
        return intervalRef.current !== null;
    }

    const handleButtonClick = (button: "start" | "pause" | "end") => {
        setActiveButton(button);

        // Call your timer functions
        if (button === "start") startTimer();
        if (button === "pause") pauseTimer();
        if (button === "end") resetTimer();
    };

    const runQuery = async (query: string) => {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: query,
                params: [1],
            }),
        });
        const data = await response.json();
        console.log(data);
    };

    return (
        <div className="timing-page">
            <div id="buttons">
                {/* Start or Resume button */}
                <button
                    id="start-button"
                    className={activeButton === "start" ? "pressed" : ""}
                    onClick={() => handleButtonClick("start")}
                >
                    {elapsedRef.current === 0 ? "Start" : "Resume"}
                </button>
                {/* Pause button */}
                <button
                    id="pause-button"
                    className={activeButton === "pause" ? "pressed" : ""}
                    onClick={() => handleButtonClick("pause")}
                    disabled={!isTimerRunning()}
                >
                    Pause
                </button>

                {/* Reset button */}
                <button
                    id="end-button"
                    className={activeButton === "end" ? "pressed" : ""}
                    onClick={() => handleButtonClick("end")}
                >
                    End
                </button>
                <hr id="colour-indicator" />
            </div>

            <p id="timer">{displayTimer}</p>
        </div>
    );
}

export default TimingPage;
