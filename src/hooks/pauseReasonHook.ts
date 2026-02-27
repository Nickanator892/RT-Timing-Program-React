import { useState, useEffect } from "react";

interface PauseReason {
    Id: string;
    name: string;
}

interface User {
    Id: number;
    name: string;
}

interface Settings {
    pauseReasons: PauseReason[];
    users: User[];
}

const execQuery = async (query: string, params: unknown[] = []): Promise<any> => {
    try {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, params }),
        });
        const data = await response.json();
        if (data.success === false) return undefined;
        return data.result;
    } catch (err) {
        console.log(err);
        return undefined;
    }
};

export function useSettings() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const loadSettings = async () => {
            const reasonRows = await execQuery("SELECT * FROM HARNBUILDPAUSEREASONS");
            const userRows = await execQuery("SELECT * FROM HARNBUILDERS");

            if (reasonRows && userRows) {
                const pauseReasons: PauseReason[] = reasonRows.map((row: any) => ({
                    Id: row["Id"],
                    name: row["reason_name"],
                }));
                const users: User[] = userRows.map((row: any) => ({
                    Id: row["Id"],
                    name: row["userName"],
                }));
                setSettings({ pauseReasons, users });
            }
            setLoading(false);
        };
        loadSettings();
    }, []);

    const addPauseReason = async (name: string) => {
        if (!settings) return;
        const result = await execQuery(
            "INSERT INTO HARNBUILDPAUSEREASONS (reason_name) VALUES (?)",
            [name]
        );
        if (result !== undefined) {
            const newReason: PauseReason = { Id: result.lastID, name };
            setSettings({ ...settings, pauseReasons: [...settings.pauseReasons, newReason] });
        }
    };

    const removePauseReason = async (id: string) => {
        if (!settings) return;
        await execQuery("DELETE FROM HARNBUILDPAUSEREASONS WHERE Id = ?", [id]);
        setSettings({
            ...settings,
            pauseReasons: settings.pauseReasons.filter((r) => r.Id !== id),
        });
    };

    const updatePauseReason = async (id: string, newName: string) => {
        if (!settings) return;
        await execQuery("UPDATE HARNBUILDPAUSEREASONS SET reason_name = ? WHERE Id = ?", [
            newName,
            id,
        ]);
        setSettings({
            ...settings,
            pauseReasons: settings.pauseReasons.map((r) =>
                r.Id === id ? { ...r, name: newName } : r
            ),
        });
    };

    const addUser = async (name: string) => {
        if (!settings) return;
        if (settings.users.some((u) => u.name === name)) return;

        const result = await execQuery("INSERT INTO HARNBUILDERS (userName) VALUES (?)", [name]);
        if (result !== undefined) {
            const newUser: User = { Id: result.lastID, name };
            setSettings({ ...settings, users: [...settings.users, newUser] });
        }
    };

    const deleteUser = async (id: number) => {
        if (!settings) return;
        await execQuery("DELETE FROM HARNBUILDERS WHERE Id = ?", [id]);
        setSettings({
            ...settings,
            users: settings.users.filter((u) => u.Id !== id),
        });
    };

    return {
        pauseReasons: settings?.pauseReasons ?? [],
        users: settings?.users ?? [],
        loading,
        addUser,
        deleteUser,
        addPauseReason,
        removePauseReason,
        updatePauseReason,
    };
}

export default useSettings;
