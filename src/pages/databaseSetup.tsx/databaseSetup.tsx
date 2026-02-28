import "./databaseSetup.css";
import { useState } from "react";

type DatabaseSetupProps = {
    onDbSet?: () => void;
};

export default function DatabaseSetup({ onDbSet }: DatabaseSetupProps) {
    const [dbSet, setDbSet] = useState(false);
    const [error, setError] = useState("");
    const [showInput, setShowInput] = useState(false);
    const [inputPath, setInputPath] = useState("");

    const setDbPath = async (path: string) => {
        if (!path) return;

        try {
            const response = await fetch("http://localhost:5000/api/set-db-path", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });

            const data = await response.json();

            if (data.success) {
                setDbSet(true);
                setError("");

                localStorage.setItem("dbPath", path);

                if (onDbSet) onDbSet();
            } else {
                setError(data.error || "Unknown server error");
            }
        } catch (err: any) {
            if (err.message === "Failed to fetch") {
                setError("Server not running");
                return;
            } else {
                setError(err.message);
            }
        }
    };

    const runQuery = async () => {
        try {
            const response = await fetch("http://127.0.0.1:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    query: "SELECT name FROM sqlite_master WHERE type='table'",
                    params: [],
                }),
            });

            await response.json();
        } catch (err) {
            console.error("Query error:", err);
        }
    };

    return (
        <div>
            {!dbSet && !showInput && (
                <button onClick={() => setShowInput(true)}>Set Database Path</button>
            )}

            {!dbSet && showInput && (
                <div id="input-div">
                    <p id="db-not-found">Database not found. Enter path to SQLite DB:</p>
                    <input
                        id="database-path-input"
                        type="text"
                        value={inputPath}
                        onChange={(e) => setInputPath(e.target.value)}
                        placeholder="C:/path/to/database.db"
                        //style={{ width: "320px", marginRight: 10 }}
                    />
                    <button id="set-path-button" onClick={() => setDbPath(inputPath)}>
                        Submit
                    </button>
                </div>
            )}

            {error && <p>{error}</p>}

            {dbSet && <button onClick={runQuery}>Run Query</button>}
        </div>
    );
}
