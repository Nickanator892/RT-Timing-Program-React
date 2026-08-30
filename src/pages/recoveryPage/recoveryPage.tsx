import "./recoveryPage.css";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBuildKit } from "../../hooks/useBuildKit";
import { useSharedState } from "../../hooks/useSharedState";
import { timerModes } from "../../common/timerModeDropdown/timerModeDropdown";
import { execQuery } from "../../assets/execQueryFunction";
import RTLogo from "../../components/RTLogo/RTLogo";
import type { RecoveryCandidate } from "../../electron";

type recoveryPageProps = {
    /** Owned by TimerLayout; setting it puts the app in its normal paused state. */
    setPauseStart: React.Dispatch<React.SetStateAction<string | null>>;
};

const INTERRUPTED_REASON = "Interrupted (app closed)";

function formatHMS(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function RecoveryPage({ setPauseStart }: recoveryPageProps) {
    const [candidate, setCandidate] = useState<RecoveryCandidate | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");
    const [selectedUser] = useSharedState<{ Id: number; name: string } | undefined>("selectedUser", undefined);
    const { fetchKit } = useBuildKit();
    const nav = useNavigate();

    useEffect(() => {
        window.electron.getRecovery().then(setCandidate);
    }, []);

    async function resumeBuild() {
        if (!candidate || busy) return;
        setBusy(true);
        setErr("");
        try {
            // The interrupted segment is still OPEN and stays that way. The dead
            // time becomes a normal pause: pauseStart is the last heartbeat, so
            // when the operator presses Start the existing resume path writes a
            // pause row spanning the outage. Worked time is untouched because
            // accumSeconds was frozen at that same heartbeat.
            const pauseStart = candidate.heartbeatAt || candidate.startTime;

            // Best-effort context. A REV unpublished since the crash must not
            // block recovery - the build and its time still exist.
            let kit: any = null;
            try {
                kit = await fetchKit(candidate.REV);
            } catch {
                kit = null;
            }

            const reasonRows = (await execQuery(
                "SELECT Id FROM HARNBUILDPAUSEREASONS WHERE reason_name = ? LIMIT 1",
                [INTERRUPTED_REASON]
            )) as { Id: number }[] | undefined;

            const secondaries = (await execQuery(
                `SELECT B.Id AS Id, B.userName AS name
                   FROM SECONDARYBUILDERS S JOIN HARNBUILDERS B ON B.Id = S.builderId
                  WHERE S.buildId = ?`,
                [candidate.buildId]
            )) as { Id: number; name: string }[] | undefined;

            const mode =
                timerModes.find((m) => m.id === candidate.timeTypeId) ?? timerModes[0];

            window.electron.updateSharedData({
                currentBuildId: candidate.buildId,
                currentSegmentId: candidate.segmentId,
                currentSegmentStart: candidate.startTime,
                startTime: candidate.buildStartTime || candidate.startTime,
                // A straight Submit (without resuming) then closes the segment at
                // the last moment the app was known alive, not at "now".
                endTime: pauseStart,
                selectedHarn: candidate.harnNumber,
                timerMode: { header: mode.header, id: mode.id },
                timerDone: false,
                isRunning: false,
                secondaryBuilders: Array.isArray(secondaries) ? secondaries : [],
                pauseReason: reasonRows?.[0]
                    ? { Id: String(reasonRows[0].Id), name: INTERRUPTED_REASON }
                    : undefined,
                ...(kit ? { selectedBuildKit: kit } : {}),
                recovery: { ...candidate, status: "RESTORED" },
            });

            // Rebuild the frozen clock in the main process: the build's total
            // earned time, paused, with heartbeats aimed at the same segment.
            await window.electron.restoreTimer({
                elapsedMs: Number(candidate.buildAccumSeconds || 0) * 1000,
                segmentId: candidate.segmentId,
                segmentAccumSeconds: Number(candidate.segmentAccumSeconds || 0),
            });

            setPauseStart(pauseStart);
            nav("/timer");
        } catch (e: any) {
            setErr(String(e?.message ?? e));
            setBusy(false);
        }
    }

    function notNow() {
        window.electron.dismissRecovery();
        nav("/choose-kit");
    }

    if (candidate === undefined) return <p className="recovery-loading">Checking for unfinished work...</p>;
    if (!candidate) {
        nav("/choose-kit");
        return null;
    }

    const stale = candidate.status === "STALE";

    return (
        <div className="recovery-page">
            <RTLogo />
            <div className={`recovery-card ${stale ? "recovery-stale" : ""}`}>
                <h2>Unfinished build found</h2>

                <div className="recovery-facts">
                    <div className="recovery-pn">{candidate.harnNumber}</div>
                    <div className="recovery-elapsed">{formatHMS(candidate.buildAccumSeconds)}</div>
                    <div className="recovery-meta">
                        <span>Started by {candidate.builderName ?? "unknown"}</span>
                        <span>Last active {candidate.heartbeatAt ?? "unknown"}</span>
                        <span>
                            {timerModes.find((m) => m.id === candidate.timeTypeId)?.header ??
                                `Mode ${candidate.timeTypeId}`}
                        </span>
                    </div>
                </div>

                {stale ? (
                    <p className="recovery-warning">
                        This build has been idle for{" "}
                        {candidate.heartbeatAt
                            ? `${Math.round(candidate.hoursSinceHeartbeat)} hours`
                            : "an unknown length of time"}
                        . Its recorded time is still correct, but check with{" "}
                        {candidate.builderName ?? "the builder"} before continuing it.
                    </p>
                ) : (
                    <p className="recovery-explain">
                        Resuming keeps the time already earned and records the interruption as a
                        pause. The timer starts paused - press Start when you are back on it.
                    </p>
                )}

                {selectedUser && candidate.builderId && selectedUser.Id !== candidate.builderId && (
                    <p className="recovery-warning">
                        This build belongs to {candidate.builderName ?? "another builder"}. It stays
                        credited to them.
                    </p>
                )}

                <div className="recovery-buttons">
                    <button id="recovery-resume" onClick={resumeBuild} disabled={busy}>
                        {busy ? "Restoring..." : "Resume this build"}
                    </button>
                    <button id="recovery-later" onClick={notNow} disabled={busy}>
                        Not now
                    </button>
                </div>
                <p className="recovery-error">{err}</p>
            </div>
        </div>
    );
}

export default RecoveryPage;
