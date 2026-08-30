import { useEffect, useState, useCallback } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import TimingPage from "./pages/timingPage/timingPage";
import DatabaseSetup from "./pages/databaseSetup.tsx/databaseSetup";
import SettingsPage from "./pages/settingsPage/settingsPage";
import PausePage from "./pages/pausePage/pausePage";
import useSettings from "./hooks/useSettings";
import { useSharedState } from "./hooks/useSharedState";
import type { PauseReason } from "./assets/types/pauseReasonType";
import LoginPage from "./pages/loginPage/loginPage";
import type { User } from "./assets/types/UserType";
import AnalyticsPage from "./pages/analyticsPage/analyticsPage";
import ChooseHarnPage from "./pages/chooseHarnPage/chooseHarnPage";
import ChooseKitPage from "./pages/chooseKitPage/chooseKitPage";
import RecoveryPage from "./pages/recoveryPage/recoveryPage";
import OnScreenKeyboard from "./common/onScreenKeyboard/onScreenKeyboard";
import Screensaver from "./common/screensaver/screensaver";

const API_BASE = "http://localhost:5000";

function TimerLayout() {
    const navigate = useNavigate();
    const [err, setErr] = useState("");
    const { pauseReasons } = useSettings();
    const [_pauseReason, setPauseReason] = useState<PauseReason | undefined>();
    const [pauseStart, setPauseStart] = useState<string | null>(null);

    const [activeButton, setActiveButton] = useState<"start" | "pause" | "end" | "submit" | null>(
        null
    );

    const [selectedUser, setSelectedUser] = useSharedState<User | undefined>(
        "selectedUser",
        undefined
    );
    const [selectedHarn, setSelectedHarn] = useSharedState<string>("selectedHarn", "");

    useEffect(() => {
        window.electron.getWindowType().then((type) => {
            if (type === "analytics") {
                navigate("/analytics");
            }
        });

        const unsubscribe = window.electron.onNavigateTo?.((route: string) => {
            navigate(route);
        });

        return unsubscribe;
    }, [navigate]);

    return (
        <>
            <Routes>
                <Route
                    path="/"
                    element={<LoginPage user={selectedUser} setUser={setSelectedUser} />}
                />
                <Route
                    path="/timer"
                    element={
                        <TimingPage
                            activeButton={activeButton}
                            setActiveButton={setActiveButton}
                            err={err}
                            setErr={setErr}
                            pauseStart={pauseStart}
                            setPauseStart={setPauseStart}
                        />
                    }
                />
                <Route path="/settings" element={<SettingsPage selectedUser={selectedUser} />} />
                <Route
                    path="/pause-reason-page"
                    element={
                        <PausePage
                            pauseReasons={pauseReasons}
                            setPauseReason={setPauseReason}
                            setErr={setErr}
                            pauseStart={pauseStart}
                            setPauseStart={setPauseStart}
                        />
                    }
                />
                <Route path="/analytics" element={<AnalyticsPage harn={selectedHarn} />} />
                <Route path="/choose-harn" element={<ChooseHarnPage setHarn={setSelectedHarn} />} />
                <Route path="/choose-kit" element={<ChooseKitPage />} />
                <Route path="/recover" element={<RecoveryPage setPauseStart={setPauseStart} />} />
            </Routes>
            {/* Mounted once for the whole app: the panel has no physical
                keyboard, and the screen would otherwise burn in overnight. */}
            <OnScreenKeyboard />
            <Screensaver />
        </>
    );
}

function App() {
    const [dbReady, setDbReady] = useState<boolean | null>(null);

    const checkDbStatus = useCallback(() => {
        console.log("Checking DB status...");
        fetch(`${API_BASE}/api/db-status`)
            .then((res) => res.json())
            .then((data) => {
                console.log("DB status response:", data);
                setDbReady(data.ready === true);
            })
            .catch((err) => {
                console.log("DB status fetch failed:", err);
                setDbReady(false);
            });
    }, []);

    useEffect(() => {
        checkDbStatus();
    }, [checkDbStatus]);

    if (dbReady === null) return <p>Checking database...</p>;
    // The keyboard is mounted here too: the database path has to be typed on a
    // panel with no physical keyboard, before the rest of the app exists.
    if (!dbReady)
        return (
            <>
                <DatabaseSetup onDbSet={checkDbStatus} />
                <OnScreenKeyboard />
            </>
        );

    return <TimerLayout />;
}

export default App;
