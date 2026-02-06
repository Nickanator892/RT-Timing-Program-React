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

function useSettings() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [loading, setLoading] = useState(true);

    // Load settings on mount
    useEffect(() => {
        window.electron
            .readSettings()
            .then((data: Settings) => {
                setSettings(data);
                setLoading(false);
            })
            .catch((err) => {
                console.error("Failed to load settings:", err);
                setLoading(false);
            });
    }, []);

    // Add a new pause reason
    const addPauseReason = async (name: string) => {
        if (!settings) return;

        const newId = (
            Math.max(...settings.pauseReasons.map((r) => parseInt(r.Id)), 0) + 1
        ).toString();
        const newReason: PauseReason = { Id: newId, name };

        const updated = {
            ...settings,
            pauseReasons: [...settings.pauseReasons, newReason],
        };

        setSettings(updated);
        await window.electron.writeSettings(updated);
    };

    // Remove a pause reason by Id
    const removePauseReason = async (id: string) => {
        if (!settings) return;

        const updated = {
            ...settings,
            pauseReasons: settings.pauseReasons.filter((r) => r.Id !== id),
        };

        setSettings(updated);
        await window.electron.writeSettings(updated);
    };

    // Update a pause reason
    const updatePauseReason = async (id: string, newName: string) => {
        if (!settings) return;

        const updated = {
            ...settings,
            pauseReasons: settings.pauseReasons.map((r) =>
                r.Id === id ? { ...r, name: newName } : r
            ),
        };

        setSettings(updated);
        await window.electron.writeSettings(updated);
    };

    const addUser = async (name: string) => {
        if (!settings) return;
        for (const user of settings.users) {
            if (user.name == name) {
                return;
            }
        }
        let prevId = 0;
        settings.users.map((u) => {
            if (u.Id > prevId) {
                prevId = u.Id;
            }
        });
        const newId = (prevId += 1);
        const newUser: User = { Id: newId, name };

        const updated = {
            ...settings,
            users: [...settings.users, newUser],
        };
        setSettings(updated);
        await window.electron.writeSettings(updated);
    };

    const deleteUser = async (id: number) => {
        if (!settings) return;

        const updated = {
            ...settings,
            users: settings.users.filter((u) => u.Id !== id),
        };

        setSettings(updated);
        await window.electron.writeSettings(updated);
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
