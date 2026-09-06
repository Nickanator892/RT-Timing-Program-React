import { useState, useEffect } from "react";
import { matchQbUser, isAutoLinkable } from "../assets/qbUserMatch";

interface PauseReason {
    Id: string;
    name: string;
    active: number;
}

interface AllPauseReasons {
    Id: string;
    name: string;
    active: number;
}

interface User {
    Id: number;
    name: string;
    password?: string;
    privLevel?: number;
    active: number;
}

interface AllUsers {
    Id: number;
    name: string;
    password?: string;
    privLevel?: number;
    active: number;
}

interface Settings {
    pauseReasons: PauseReason[];
    allPauseReasons: AllPauseReasons[];
    users: User[];
    allUsers: AllUsers[];
}

const execQuery = async (query: string, params: unknown[] = []): Promise<any> => {
    try {
        console.log("Sending query:", query);
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, params }),
        });
        console.log("Response status:", response.status);
        const data = await response.json();
        console.log("Response data:", data);
        if (data.success === false) return undefined;
        return data.result;
    } catch (err) {
        console.log("execQuery error:", err);
        return undefined;
    }
};

/**
 * Link a newly added builder to their QuickBooks Time user, when the match is
 * unambiguous.
 *
 * Best effort and silent: a station whose roster has not been polled yet, or a
 * name nobody on it resembles, simply leaves the builder unlinked - the
 * QuickBooks Time screen then offers it as a one-click suggestion. Adding a
 * builder must never fail because of this.
 *
 * Linking is NOT opting in: qbAutoPause stays 0 until someone ticks the box, so
 * nobody starts getting their timer paused merely because they were matched.
 */
async function tryAutoLinkQbUser(builderId: number, userName: string): Promise<void> {
    try {
        const roster = await execQuery(
            "SELECT qbTimeUserId, displayName, username, active FROM QBTIMEUSERS"
        );
        if (!Array.isArray(roster) || roster.length === 0) return;

        const taken = await execQuery(
            "SELECT qbTimeUserId FROM HARNBUILDERS WHERE qbTimeUserId IS NOT NULL"
        );
        const takenIds = Array.isArray(taken) ? taken.map((r: any) => Number(r.qbTimeUserId)) : [];

        const match = matchQbUser(userName, roster, takenIds);
        if (!isAutoLinkable(match)) return;

        await execQuery("UPDATE HARNBUILDERS SET qbTimeUserId = ? WHERE Id = ?", [
            match.qbTimeUserId,
            builderId,
        ]);
    } catch (err) {
        console.log("QuickBooks auto-link skipped:", err);
    }
}

export function useSettings() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [loading, setLoading] = useState(true);

useEffect(() => {
    const loadSettings = async () => {
        let success = false;
        let attempts = 0;

        while (!success && attempts < 10) {
            try {
                const [reasonRows, allPauseReasonsRows, userRows, allUserRows] = await Promise.all([
                    await execQuery("SELECT * FROM HARNBUILDPAUSEREASONS WHERE active = 1"),
                    await execQuery("SELECT * FROM HARNBUILDPAUSEREASONS"),
                    await execQuery("SELECT * FROM HARNBUILDERS WHERE active != 0"),
                    await execQuery("SELECT * FROM HARNBUILDERS ORDER BY active DESC"),
                ]);

                if (reasonRows && allPauseReasonsRows && userRows && allUserRows) {
                    const pauseReasons: PauseReason[] = reasonRows.map((row: any) => ({
                        Id: row["Id"],
                        name: row["reason_name"],
                        active: row["active"],
                    }));
                    const allPauseReasons: AllPauseReasons[] = allPauseReasonsRows.map((row: any) => ({
                        Id: row["Id"],
                        name: row["reason_name"],
                        active: row["active"],
                    }));
                    const users: User[] = userRows.map((row: any) => ({
                        Id: row["Id"],
                        name: row["userName"],
                        password: row["password"],
                        privLevel: row["privLevel"],
                        active: row["active"],
                    }));
                    const allUsers: AllUsers[] = allUserRows.map((row: any) => ({
                        Id: row["Id"],
                        name: row["userName"],
                        password: row["password"],
                        privLevel: row["privLevel"],
                        active: row["active"],
                    }));

                    setSettings({ pauseReasons, allPauseReasons, users, allUsers });
                    success = true;
                } else {
                    throw new Error("One or more queries returned undefined");
                }
            } catch (err) {
                attempts++;
                console.log(`Settings load attempt ${attempts}/10 failed, retrying in 1s...`);
                await new Promise(res => setTimeout(res, 1000));
            }
        }

        if (!success) {
            console.error("Failed to load settings after 10 attempts");
        }

        setLoading(false);
    };

    loadSettings();
}, []);

    const addPauseReason = async (name: string) => {
        if (!settings) return;
        const result = await execQuery(
            "INSERT INTO HARNBUILDPAUSEREASONS (reason_name, active) VALUES (?, 1)",
            [name]
        );
        if (result !== undefined) {
            const newReason: PauseReason = { Id: result.lastID, name, active: 1 };
            setSettings({ ...settings, pauseReasons: [...settings.pauseReasons, newReason] });
            setSettings({ ...settings, allPauseReasons: [...settings.allPauseReasons, newReason] });
        }
    };

    const deActivatePauseReason = async (id: string) => {
        if (!settings) return;
        await execQuery("UPDATE HARNBUILDPAUSEREASONS SET active=0 WHERE Id = ?", [id]);
        setSettings({
            ...settings,
            pauseReasons: settings.pauseReasons.filter((r) => r.Id !== id),
            allPauseReasons: settings.allPauseReasons.map((r) =>
                r.Id === id ? { ...r, id: id, active: 0 } : r
            ),
        });
    };

    const reActivatePauseReason = async (id: string) => {
        if (!settings) return;
        await execQuery("UPDATE HARNBUILDPAUSEREASONS SET active = 1 WHERE Id = ?", [id]);
        setSettings({
            ...settings,
            pauseReasons: settings.pauseReasons.map((r) =>
                r.Id === id ? { ...r, id: id, active: 1 } : r
            ),
            allPauseReasons: settings.allPauseReasons.map((r) =>
                r.Id === id ? { ...r, id: id, active: 1 } : r
            ),
        });
    };

    const addUser = async (name: string, privLevel: number, password: string) => {
        if (!settings) return;
        if (settings.users.some((u) => u.name === name)) return;
        if (!password || password.trim() == "") {
            password = "";
        }

        const result = await execQuery(
            "INSERT INTO HARNBUILDERS (userName, password, privLevel, active) VALUES (?, ?, ?, ?)",
            [name, password, privLevel, 1]
        );
        if (result !== undefined) {
            // Best effort: link the new builder to their QuickBooks Time user
            // straight away, but only on a confident match. A nickname that
            // merely looks like someone ("nicky" / "Nicholas") is left for a
            // human on the QuickBooks Time screen, which shows it as a
            // one-click suggestion. Linking never opts anyone into auto-pause -
            // that stays a separate, deliberate tick.
            await tryAutoLinkQbUser(result.lastID, name);

            const newUser: User = {
                Id: result.lastID,
                name,
                password: "",
                privLevel: 3,
                active: 1,
            };
            setSettings({ ...settings, users: [...settings.users, newUser] });
            setSettings({ ...settings, allUsers: [...settings.allUsers, newUser] });
        }
    };

    const deActivateUser = async (id: number) => {
        if (!settings) return;
        await execQuery("UPDATE HARNBUILDERS SET active=0 WHERE Id = ?", [id]);
        setSettings({
            ...settings,
            users: settings.users.filter((u) => u.Id !== id),
            allUsers: settings.allUsers.map((u) => (u.Id === id ? { ...u, active: 0 } : u)),
        });
    };

    const activateUser = async (id: number) => {
        if (!settings) return;
        await execQuery("UPDATE HARNBUILDERS SET active=1 WHERE Id = ?", [id]);
        setSettings({
            ...settings,
            users: [...settings.users, settings.allUsers.find((u) => u.Id === id)!].map((u) =>
                u.Id === id ? { ...u, active: 1 } : u
            ),
            allUsers: settings.allUsers.map((u) => (u.Id === id ? { ...u, active: 1 } : u)),
        });
    };

    return {
        pauseReasons: settings?.pauseReasons ?? [],
        users: settings?.users ?? [],
        allUsers: settings?.allUsers ?? [],
        allPauseReasons: settings?.allPauseReasons ?? [],
        loading,
        addUser,
        deActivateUser,
        activateUser,
        addPauseReason,
        deActivatePauseReason,
        reActivatePauseReason,
    };
}

export default useSettings;
