import "./qbTimeMapping.css";
import { useEffect, useState } from "react";
import { execQuery } from "../../assets/execQueryFunction";
import { parseTimestamp } from "../../assets/timeDistribution";

/**
 * Links shop builders to QuickBooks Time users, and controls who is affected
 * by the clock.
 *
 * Auto-pause is opt-in per person on purpose: office staff appear in
 * QuickBooks Time too, and their clocking out must never touch a build. A
 * builder with the box unticked behaves exactly as before this feature existed.
 *
 * The roster and clock state are written by the poller on the Windows host;
 * this screen only reads them, so the station never needs the API token.
 */

interface Builder {
    Id: number;
    userName: string;
    qbTimeUserId: number | null;
    qbAutoPause: number | null;
}

interface QbUser {
    qbTimeUserId: number;
    displayName: string;
}

interface ClockRow {
    qbTimeUserId: number;
    onTheClock: number;
}

type qbTimeMappingProps = { onClose: () => void };

function QbTimeMapping({ onClose }: qbTimeMappingProps) {
    const [builders, setBuilders] = useState<Builder[]>([]);
    const [qbUsers, setQbUsers] = useState<QbUser[]>([]);
    const [clock, setClock] = useState<Record<number, number>>({});
    const [pollAge, setPollAge] = useState<string>("checking...");
    const [msg, setMsg] = useState("");

    async function load() {
        const b = (await execQuery(
            "SELECT Id, userName, qbTimeUserId, qbAutoPause FROM HARNBUILDERS WHERE active != 0 ORDER BY userName"
        )) as Builder[] | undefined;
        const u = (await execQuery(
            "SELECT qbTimeUserId, displayName FROM QBTIMEUSERS ORDER BY displayName"
        )) as QbUser[] | undefined;
        const s = (await execQuery("SELECT qbTimeUserId, onTheClock FROM QBTIMESTATUS")) as
            | ClockRow[]
            | undefined;
        const p = (await execQuery("SELECT lastPollAt, lastError FROM QBTIMEPOLL WHERE id = 1")) as
            | { lastPollAt: string | null; lastError: string | null }[]
            | undefined;

        setBuilders(Array.isArray(b) ? b : []);
        setQbUsers(Array.isArray(u) ? u : []);
        setClock(
            Array.isArray(s)
                ? Object.fromEntries(s.map((r) => [Number(r.qbTimeUserId), Number(r.onTheClock)]))
                : {}
        );

        const last = parseTimestamp(p?.[0]?.lastPollAt);
        if (!last) {
            setPollAge("never - the poller on the office PC is not running");
        } else {
            const mins = Math.round((Date.now() - last.getTime()) / 60000);
            setPollAge(
                mins <= 2
                    ? `live (updated ${mins <= 0 ? "just now" : `${mins} min ago`})`
                    : `STALE - last updated ${mins} min ago; auto-pause is inactive until it recovers`
            );
        }
        if (p?.[0]?.lastError) setMsg(`Poller error: ${p[0].lastError}`);
    }

    useEffect(() => {
        load();
        const id = window.setInterval(load, 30_000);
        return () => window.clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function link(builderId: number, qbTimeUserId: string) {
        await execQuery("UPDATE HARNBUILDERS SET qbTimeUserId = ? WHERE Id = ?", [
            qbTimeUserId === "" ? null : Number(qbTimeUserId),
            builderId,
        ]);
        // Linking someone does not opt them in - that stays a separate, explicit
        // decision, so nobody starts getting paused just because they were mapped.
        load();
    }

    async function toggleAuto(builderId: number, on: boolean) {
        await execQuery("UPDATE HARNBUILDERS SET qbAutoPause = ? WHERE Id = ?", [on ? 1 : 0, builderId]);
        load();
    }

    return (
        <div className="qbtime-overlay">
            <div className="qbtime-modal">
                <h3>QuickBooks Time</h3>
                <p className={`qbtime-status ${pollAge.startsWith("live") ? "ok" : "warn"}`}>
                    Clock feed: {pollAge}
                </p>

                <div className="qbtime-rows">
                    <div className="qbtime-row qbtime-head">
                        <span>Builder</span>
                        <span>QuickBooks Time user</span>
                        <span>Now</span>
                        <span>Clock controls timer</span>
                    </div>
                    {builders.map((b) => {
                        const on = b.qbTimeUserId ? clock[Number(b.qbTimeUserId)] : undefined;
                        return (
                            <div className="qbtime-row" key={b.Id}>
                                <span className="qbtime-name">{b.userName}</span>
                                <select
                                    value={b.qbTimeUserId ?? ""}
                                    onChange={(e) => link(b.Id, e.target.value)}
                                >
                                    <option value="">(not linked)</option>
                                    {qbUsers.map((u) => (
                                        <option key={u.qbTimeUserId} value={u.qbTimeUserId}>
                                            {u.displayName}
                                        </option>
                                    ))}
                                </select>
                                <span className={`qbtime-clock ${on === 1 ? "in" : on === 0 ? "out" : ""}`}>
                                    {on === 1 ? "IN" : on === 0 ? "OUT" : "-"}
                                </span>
                                <input
                                    type="checkbox"
                                    checked={Number(b.qbAutoPause) === 1}
                                    disabled={!b.qbTimeUserId}
                                    onChange={(e) => toggleAuto(b.Id, e.target.checked)}
                                />
                            </div>
                        );
                    })}
                </div>

                <p className="qbtime-explain">
                    Ticked: clocking out of QuickBooks pauses that builder's running timer and blocks
                    Start until they clock back in. Clocking in never resumes a timer on its own.
                </p>
                <p className="qbtime-msg">{msg}</p>
                <button type="button" className="qbtime-close" onClick={onClose}>
                    Done
                </button>
            </div>
        </div>
    );
}

export default QbTimeMapping;
