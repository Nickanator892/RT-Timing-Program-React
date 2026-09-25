import { useCallback, useEffect, useState } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import { timerModes } from "../timerModeDropdown/timerModeDropdown";
import { holdScreensaver } from "../screensaver/screensaver";
import {
    checkSegmentStatus,
    clearCarryoverClock,
    hasUnsubmittedTime,
    isSegmentStale,
} from "../../assets/carryoverGuard";
import "./carryoverLock.css";

/**
 * "Submit it or discard it before changing harness, job or mode."
 *
 * Randy, 2026-09-25 (project_pi_session_restore_carryover.md): the 09-24/25
 * incident happened because nothing stopped an operator from switching
 * harness (or job, or mode) while the PREVIOUS one still had unsubmitted time
 * on the clock - insertPause and the eventual Submit kept writing against the
 * old build under the new harness's name. This is the one gate all of those
 * changes go through now: the harness icon, the kit/job icon, the mode
 * dropdown, App.tsx's setHarn wrapper (the actual mutation ChooseHarnPage
 * calls), and HandoffOffer's accept path all call requestGuardedChange
 * instead of applying their change directly.
 *
 * Mounted once in TimerLayout, the same level as HandoffOffer - it has to be
 * reachable from any page, not just the timer page, because the App.tsx
 * setHarn guard fires from /choose-harn.
 *
 * Submit/End are NOT reimplemented here. TimingPage registers its own
 * submitTime/resetTimer into carryoverBridge (a plain module-level object, not
 * React state) whenever it is mounted, using refs so the registered functions
 * always call the LATEST closure rather than the one captured at registration
 * time. If TimingPage happens not to be mounted (the App.tsx backstop case,
 * which the harness-icon guard should make unreachable in practice) the
 * Submit button is disabled with a short explanation rather than failing
 * silently.
 */

export type GuardedKind = "harness" | "job" | "mode";

interface GuardDetail {
    kind: GuardedKind;
    onProceed: () => void;
}

export const carryoverBridge: {
    submit: (() => Promise<void>) | null;
    end: (() => void) | null;
} = { submit: null, end: null };

const REQUEST_EVENT = "rt-carryover-guard-request";

/**
 * Ask permission to change harness, job/kit or timer mode. Fails OPEN
 * (proceeds immediately) if nothing answered the event - CarryoverLockGuard is
 * always mounted by TimerLayout, so that should only ever happen if this
 * module is used from outside the app shell.
 */
export function requestGuardedChange(kind: GuardedKind, onProceed: () => void): void {
    const notCanceled = window.dispatchEvent(
        new CustomEvent<GuardDetail>(REQUEST_EVENT, { detail: { kind, onProceed }, cancelable: true })
    );
    if (notCanceled) onProceed();
}

async function postApi(route: string, body: unknown): Promise<any> {
    const response = await fetch(`http://localhost:5000${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!data?.success) throw new Error(data?.error || `${route} failed`);
    return data.result;
}

function kindNoun(kind: GuardedKind): string {
    if (kind === "harness") return "harness";
    if (kind === "job") return "job";
    return "mode";
}

type Pending = { kind: GuardedKind; onProceed: () => void };

type Props = {
    setPauseStart: React.Dispatch<React.SetStateAction<string | null>>;
};

function CarryoverLockGuard({ setPauseStart }: Props) {
    const [pending, setPending] = useState<Pending | null>(null);
    const [confirmingDiscard, setConfirmingDiscard] = useState(false);
    const [busy, setBusy] = useState(false);
    const [dialogErr, setDialogErr] = useState("");

    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [timerMode] = useSharedState<{ header: string; id: number }>("timerMode", {
        header: "Timing Build",
        id: 1,
    });

    const clear = useCallback(
        (notice?: string) => {
            clearCarryoverClock(notice);
            setPauseStart(null);
        },
        [setPauseStart]
    );

    const resolve = useCallback((detail: GuardDetail) => {
        setPending(null);
        setConfirmingDiscard(false);
        setDialogErr("");
        detail.onProceed();
    }, []);

    useEffect(() => {
        function onRequest(e: Event) {
            const ce = e as CustomEvent<GuardDetail>;
            const detail = ce.detail;
            // preventDefault tells requestGuardedChange "handled - do not also
            // fail open and call onProceed yourself".
            e.preventDefault();

            void (async () => {
                const shared = await window.electron.getSharedData();
                if (!hasUnsubmittedTime(shared?.isRunning, shared?.elapsedTime, shared?.timerDone)) {
                    detail.onProceed();
                    return;
                }
                // Item 1(b): verify it is not actually stale before bothering
                // anyone with a dialog. A closed/missing segment means the
                // apparent "unsubmitted time" is a carryover from a build the
                // database already dealt with, not real work in progress.
                const elapsed = Number(shared?.elapsedTime ?? 0);
                const totalSeconds = Math.max(0, Math.floor(elapsed / 1000));
                const displayTimer =
                    `${String(Math.floor(totalSeconds / 3600)).padStart(2, "0")}:` +
                    `${String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0")}:` +
                    `${String(totalSeconds % 60).padStart(2, "0")}`;
                const result = await checkSegmentStatus(
                    Number(shared?.currentSegmentId ?? 0),
                    displayTimer,
                    shared?.timerMode?.id
                );
                if (isSegmentStale(result.status)) {
                    clear(result.message);
                    detail.onProceed();
                    return;
                }
                // Genuinely locked - ask.
                setPending({ kind: detail.kind, onProceed: detail.onProceed });
            })();
        }
        window.addEventListener(REQUEST_EVENT, onRequest);
        return () => window.removeEventListener(REQUEST_EVENT, onRequest);
    }, [clear]);

    // Sit above the screensaver (20000) rather than relying on holdScreensaver
    // alone - the handoff dialog was 15000, under it, and a real question could
    // sit unanswered behind "Touch to begin" (see handoffOffer.tsx history).
    // holdScreensaver is still worth calling too: it stops the idle countdown
    // from re-arming mid-decision on a panel that just woke to press the icon.
    useEffect(() => {
        if (!pending) return;
        holdScreensaver(true);
        return () => holdScreensaver(false);
    }, [pending]);

    // Read for the dialog's own display only - the guard decision itself
    // already used a fresh window.electron.getSharedData() snapshot above.
    const [elapsedTime] = useSharedState<number>("elapsedTime", 0);

    async function handleSubmit() {
        setBusy(true);
        setDialogErr("");
        try {
            const shared = await window.electron.getSharedData();
            if (shared?.isRunning) {
                carryoverBridge.end?.();
                // resetTimer's own effects (state update, an IPC round trip to
                // main) are not synchronous - wait for isRunning to actually
                // land false rather than racing submitTime against them.
                for (let i = 0; i < 20; i++) {
                    await new Promise((r) => setTimeout(r, 50));
                    const s = await window.electron.getSharedData();
                    if (!s?.isRunning) break;
                }
            }
            const submit = carryoverBridge.submit;
            if (!submit) {
                throw new Error(
                    "The timer page is not open, so there is nothing here that can submit it. " +
                        "Open the timer page and press Submit, or Discard instead."
                );
            }
            await submit();
            if (pending) resolve(pending);
        } catch (e: any) {
            setDialogErr(String(e?.message ?? e));
        } finally {
            setBusy(false);
        }
    }

    async function handleDiscard() {
        if (!confirmingDiscard) {
            setConfirmingDiscard(true);
            return;
        }
        setBusy(true);
        setDialogErr("");
        try {
            const shared = await window.electron.getSharedData();
            const buildId = Number(shared?.currentBuildId ?? 0);
            if (buildId > 0) {
                // /api/build/discard (server.ts) only deletes a build with at
                // least one OPEN segment on THIS station - a build every
                // segment of which is already closed is refused (requireChanges
                // 1 on that guard), so this can never eat an already-submitted
                // build even if buildId is stale.
                await postApi("/api/build/discard", { buildId });
            }
            clear();
            if (pending) resolve(pending);
        } catch (e: any) {
            setDialogErr(String(e?.message ?? e));
            setConfirmingDiscard(false);
        } finally {
            setBusy(false);
        }
    }

    function handleCancel() {
        setPending(null);
        setConfirmingDiscard(false);
        setDialogErr("");
    }

    if (!pending) return null;

    const seconds = Math.max(0, Math.floor(elapsedTime / 1000));
    const hms =
        `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:` +
        `${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:` +
        `${String(seconds % 60).padStart(2, "0")}`;
    const modeShort = timerModes.find((m) => m.id === timerMode.id)?.label.replace("Timer Mode: ", "") ?? "";

    return (
        <div className="carryover-backdrop" role="dialog" aria-modal="true" aria-label="Unsubmitted time">
            <div className="carryover-card">
                <p className="carryover-title">Unsubmitted time</p>
                <p className="carryover-body">
                    {selectedHarn} ({modeShort}) has {hms} that is not submitted. Submit it or discard it
                    before changing {kindNoun(pending.kind)}.
                </p>
                {dialogErr && <p className="carryover-error">{dialogErr}</p>}
                <div className="carryover-buttons">
                    <button
                        type="button"
                        id="carryover-submit"
                        className="carryover-submit"
                        disabled={busy}
                        onClick={() => void handleSubmit()}
                    >
                        Submit
                    </button>
                    <button
                        type="button"
                        id="carryover-discard"
                        className="carryover-discard"
                        disabled={busy}
                        onClick={() => void handleDiscard()}
                    >
                        {confirmingDiscard ? "Are you sure? Tap again to discard" : "Discard"}
                    </button>
                    <button
                        type="button"
                        id="carryover-cancel"
                        className="carryover-cancel"
                        disabled={busy}
                        onClick={handleCancel}
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}

export default CarryoverLockGuard;
