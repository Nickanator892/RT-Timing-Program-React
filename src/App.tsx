// App.tsx
import { useEffect, useState, useCallback, useRef } from "react";
import TimingPage from "./pages/timingPage/timingPage";
import DatabaseSetup from "./pages/databaseSetup.tsx/databaseSetup";
import { Route, Routes, Outlet } from "react-router-dom";
import SettingsPage from "./pages/settingsPage/settingsPage";
import PausePage from "./pages/pausePage/pausePage";
import useSettings from "./hooks/pauseReasonHook";
import type { PauseReason } from "./assets/types/pauseReasonType";

const API_BASE = "http://localhost:5000";

function TimerLayout() {
    const [err, setErr] = useState("");
    const { pauseReasons, loading } = useSettings();
    const [pauseReason, setPauseReason] = useState<PauseReason[]>([]);
    const [displayTimer, setDisplayTimer] = useState<string>("00:00:00");
    const [activeButton, setActiveButton] = useState<"start" | "pause" | "end" | "submit" | null>(null);
    const intervalRef = useRef<number | null>(null);
    const startRef = useRef<number | null>(null);
    const elapsedRef = useRef(0);

    useEffect(() => {
        if (pauseReasons.length > 0) {
            setPauseReason(pauseReasons);
        }
    }, [pauseReasons]);

    const timerProps = {
        displayTimer,
        setDisplayTimer,
        activeButton,
        setActiveButton,
        pauseReason,
        err,
        setErr,
        intervalRef,
        startRef,
        elapsedRef
    };

    return (
        <Routes>
            <Route path="/" element={<TimingPage {...timerProps} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/pause-reason-page" element={<PausePage pauseReasons={pauseReasons} setPauseReason={setPauseReason} setErr={setErr} />} />
        </Routes>
    );
}

function App() {
    const [dbReady, setDbReady] = useState<boolean | null>(null);

    const checkDbStatus = useCallback(() => {
        fetch(`${API_BASE}/api/db-status`)
            .then((res) => res.json())
            .then((data) => {
                setDbReady(data.ready === true);
            })
            .catch(() => {
                setDbReady(false);
            });
    }, []);

    useEffect(() => {
        checkDbStatus();
    }, [checkDbStatus]);

    if (dbReady === null) {
        return <p>Checking database...</p>;
    }

    if (!dbReady) {
        return <DatabaseSetup onDbSet={checkDbStatus} />;
    }

    return <TimerLayout />;
}

export default App;