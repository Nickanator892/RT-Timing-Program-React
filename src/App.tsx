import { useEffect, useState, useCallback, useRef } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import TimingPage from "./pages/timingPage/timingPage";
import DatabaseSetup from "./pages/databaseSetup.tsx/databaseSetup";
import SettingsPage from "./pages/settingsPage/settingsPage";
import PausePage from "./pages/pausePage/pausePage";
import useSettings from "./hooks/pauseReasonHook";
import { useSharedState } from "./hooks/useSharedState";
import type { PauseReason } from "./assets/types/pauseReasonType";
import LoginPage from "./pages/loginPage/loginPage";
import type { User } from "./assets/types/UserType";
import AnalyticsPage from "./pages/analyticsPage/analyticsPage";
import ChooseHarnPage from "./pages/chooseHarnPage/chooseHarnPage";
import type { LoggedTime } from "./hooks/loggedTimesHook";

const API_BASE = "http://localhost:5000";

function TimerLayout() {
    const navigate = useNavigate();
    const [err, setErr] = useState("");
    const { pauseReasons, loading } = useSettings();
    const [pauseReason, setPauseReason] = useState<PauseReason[]>([]);
    
    // Use shared state for timer-related data
    const [displayTimer, setDisplayTimer] = useSharedState<string>("displayTimer", "00:00:00");
    const [activeButton, setActiveButton] = useSharedState<"start" | "pause" | "end" | "submit" | null>(
        "activeButton", 
        null
    );
    const [selectedUser, setSelectedUser] = useSharedState<User | undefined>("selectedUser", undefined);
    const [loggedTimes, setLoggedTimes] = useState<LoggedTime[]>();
    const [isRunning, setIsRunning] = useSharedState<boolean>("isRunning", false);
    
    const intervalRef = useRef<number | null>(null);
    const startRef = useRef<number | null>(null);
    const elapsedRef = useRef(0);
    const [windowType, setWindowType] = useState<string>("main");
    const [selectedHarn, setSelectedHarn] = useSharedState<string>("selectedHarn", "")

    useEffect(() => {
        // Determine window type
        window.electron.getWindowType().then(type => {
            setWindowType(type);
            if (type === "analytics") {
                navigate("/analytics");
            }
        });

        // Listen for navigation commands (for analytics window)
        const unsubscribe = window.electron.onNavigateTo?.((route: string) => {
            navigate(route);
        });

        return unsubscribe;
    }, [navigate]);

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
        elapsedRef,
        selectedUser,
        setIsRunning,
    };

    return (
        <>
            <Routes>
                <Route path="/" element={<LoginPage user={selectedUser} setUser={setSelectedUser} />} />
                <Route path="/timer" element={<TimingPage {...timerProps} />} />
                <Route path="/settings" element={<SettingsPage selectedUser={selectedUser} />} />
                <Route
                    path="/pause-reason-page"
                    element={
                        <PausePage
                            pauseReasons={pauseReasons}
                            setPauseReason={setPauseReason}
                            setErr={setErr}
                        />
                    }
                />
                <Route path="/analytics" element={<AnalyticsPage harn={selectedHarn}/>} />
                <Route path="/choose-harn" element={<ChooseHarnPage setHarn={setSelectedHarn}/>}/>
            </Routes>
        </>
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