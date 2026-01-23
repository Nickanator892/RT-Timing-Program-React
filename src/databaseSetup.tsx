// src/DatabaseSetup.tsx
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
            const response = await fetch("http://127.0.0.1:5000/api/set-db-path", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path }),
            });

            const data = await response.json();

            if (data.success) {
                setDbSet(true);
                setError("");

                // ✅ Store path for renderer-side use
                localStorage.setItem("dbPath", path);

                if (onDbSet) onDbSet();
            } else {
                setError(data.error || "Unknown server error");
            }
        } catch (err: any) {
            setError(err.message);
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

            const data = await response.json();
            console.log("Query result:", data);
        } catch (err) {
            console.error("Query error:", err);
        }
    };

    return (
        <div style={{ marginTop: 20 }}>
            {!dbSet && !showInput && (
                <button onClick={() => setShowInput(true)}>Set Database Path</button>
            )}

            {!dbSet && showInput && (
                <div style={{ marginTop: 10 }}>
                    <p>Database not found. Enter path to SQLite DB:</p>
                    <input
                        type="text"
                        value={inputPath}
                        onChange={(e) => setInputPath(e.target.value)}
                        placeholder="C:/path/to/database.db"
                        style={{ width: "320px", marginRight: 10 }}
                    />
                    <button onClick={() => setDbPath(inputPath)}>Submit</button>
                </div>
            )}

            {error && <p style={{ color: "red" }}>{error}</p>}

            {dbSet && (
                <button style={{ marginTop: 10 }} onClick={runQuery}>
                    Run Query
                </button>
            )}
        </div>
    );
}
