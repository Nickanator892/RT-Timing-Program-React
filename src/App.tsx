import { useEffect, useState, useCallback } from "react";
import TimingPage from "./pages/timingPage/timingPage";
import DatabaseSetup from "./pages/databaseSetup.tsx/databaseSetup";

const API_BASE = "http://localhost:5000";

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

    // Check on app startup
    useEffect(() => {
        checkDbStatus();
    }, [checkDbStatus]);

    if (dbReady === null) {
        return <p>Checking database...</p>;
    }

    if (!dbReady) {
        return <DatabaseSetup onDbSet={checkDbStatus} />;
    }

    return <TimingPage />;
}

export default App;
