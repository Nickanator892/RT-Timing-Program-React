import { useEffect, useState, useCallback } from "react";
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
import ChooseKitPage from "./pages/chooseKitPage/chooseKitPage";

const API_BASE = "http://localhost:5000";

function TimerLayout() {
    const navigate = useNavigate();
    const [err, setErr] = useState("");
    const { pauseReasons } = useSettings();
    const [pauseReason, setPauseReason] = useState<PauseReason | undefined>();
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

    if (dbReady === null) return <p>Checking database...</p>;
    if (!dbReady) return <DatabaseSetup onDbSet={checkDbStatus} />;

    return <TimerLayout />;
}

export default App;
