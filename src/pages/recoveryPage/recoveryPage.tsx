import "./recoveryPage.css";
import { useEffect, useRef, useState } from "react";
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
    /** Also owned by TimerLayout. A restored build has to LOOK paused - the
     *  yellow indicator is driven by this, and without it the timer page comes
     *  up looking idle even though a build is loaded and waiting. */
    setActiveButton: React.Dispatch<
        React.SetStateAction<"start" | "pause" | "end" | "submit" | null>
    >;
};

const INTERRUPTED_REASON = "Interrupted (app closed)";

/**
 * Whether this candidate is restored without asking.
 *
 * The builder who left the build open gets it back the moment they log in -
 * that is the whole point, and there is nothing for them to decide. Two cases
 * still stop and ask:
 *   - STALE: no heartbeat, or over 12 hours old, so an unknown amount of work
 *     is missing and someone has to reconcile it (Manual Time Entry).
 *   - A DIFFERENT builder logging in: the build stays credited to its owner, so
 *     taking it over is a real decision and must not happen by walking past a
 *     screen. They can still resume it from the card.
 */
function shouldAutoResume(candidate: RecoveryCandidate, userId?: number): boolean {
    if (candidate.status !== "RECOVERABLE") return false;
    if (candidate.builderId == null || userId == null) return false;
    return Number(userId) === Number(candidate.builderId);
}

function formatHMS(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

function RecoveryPage({ setPauseStart, setActiveButton }: recoveryPageProps) {
    const [candidate, setCandidate] = useState<RecoveryCandidate | null | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const [auto, setAuto] = useState(false);
    const [err, setErr] = useState("");
    const [selectedUser, , userReady] = useSharedState<{ Id: number; name: string } | undefined>("selectedUser", undefined);
    const { fetchKit } = useBuildKit();
    const nav = useNavigate();
    // One attempt only. The effect re-runs whenever shared state changes, and a
    // second restore over a build already loaded would double-count its time.
    const autoTried = useRef(false);

    useEffect(() => {
        window.electron.getRecovery().then(setCandidate);
    }, []);

    // Auto-restore. Deliberately waits for userReady: selectedUser arrives over
    // IPC a beat after mount, and deciding before it lands would show the card
    // to the owner - the exact hand-work this removes.
    useEffect(() => {
        if (!candidate || !userReady || autoTried.current) return;
        if (!shouldAutoResume(candidate, selectedUser?.Id)) return;
        autoTried.current = true;
        setAuto(true);
        // On success resumeBuild navigates away; on failure it sets err and the
        // card renders with a manual Resume button, so nothing is stranded.
        resumeBuild().finally(() => setAuto(false));
    }, [candidate, userReady, selectedUser?.Id]);

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
            // Land on the timer looking the way a pause looks: yellow indicator,
            // and Start already reading "Resume" because the clock is non-zero.
            setActiveButton("pause");
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

    // userReady gates the whole decision, not just the effect: rendering the
    // card first and auto-restoring a moment later would flash a choice at the
    // operator that they might act on.
    if (candidate === undefined || !userReady)
        return <p className="recovery-loading">Checking for unfinished work...</p>;
    if (!candidate) {
        nav("/choose-kit");
        return null;
    }

    if (auto)
        return (
            <div className="recovery-page">
                <RTLogo />
                <div className="recovery-card">
                    <h2>Picking your build back up</h2>
                    <div className="recovery-facts">
                        <div className="recovery-pn">{candidate.harnNumber}</div>
                        <div className="recovery-elapsed">{formatHMS(candidate.buildAccumSeconds)}</div>
                    </div>
                    <p className="recovery-explain">
                        Restoring your time and recording the interruption as a pause. The timer
                        opens paused - press Resume when you are back on it.
                    </p>
                </div>
            </div>
        );

    const stale = candidate.status === "STALE";
    const otherBuilder =
        candidate.builderId != null &&
        selectedUser?.Id != null &&
        Number(selectedUser.Id) !== Number(candidate.builderId);

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
                        . The time shown is what was recorded up to the last activity we can
                        prove{candidate.heartbeatAt ? ` (${candidate.heartbeatAt})` : ""} - any work
                        after that was not saved and is not included. Check with{" "}
                        {candidate.builderName ?? "the builder"} before continuing, and add any
                        missing time with Manual Time Entry in Settings.
                    </p>
                ) : (
                    <p className="recovery-explain">
                        Resuming keeps the time already earned and records the interruption as a
                        pause. The timer starts paused - press Start when you are back on it.
                    </p>
                )}

                {otherBuilder && (
                    <p className="recovery-warning">
                        This build belongs to {candidate.builderName ?? "another builder"}, which is
                        why it was not opened for you automatically. It stays credited to them.
                    </p>
                )}

                <div className="recovery-buttons">
                    <button id="recovery-resume" onClick={resumeBuild} disabled={busy}>
                        {busy ? "Restoring..." : otherBuilder ? "Take over this build" : "Resume this build"}
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
