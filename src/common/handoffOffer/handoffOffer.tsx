import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";
import { timerModes } from "../timerModeDropdown/timerModeDropdown";
import "./handoffOffer.css";

/**
 * An offer from the Cirris test station to stage a timer.
 *
 * The tester no longer starts a timer remotely. It writes a row saying "this
 * part number is loaded over here", the bench offers it, and accepting sets the
 * harness, the mode and the unit count so the operator only has to press Start.
 * Contract: RT-Cirris-Test-Program docs/whpp/HPP-STAGE-THE-TIMER-2026-09-12.md.
 *
 * The clock is never started by this. Staging is the whole point - a timer that
 * starts itself from another room records time nobody was working.
 */

const POLL_MS = 3_000;          // the tester polls at 4s; beat it
/** How long the dialog waits for an answer before resolving itself. */
const ANSWER_MS = 3 * 60_000;

interface Offer {
    HandoffId: number;
    Kind: string;
    FromStation: string | null;
    HarnPn: string;
    Rev: number | null;
    TimeTypeId: number | null;
    BatchUnits: number | null;
    Note: string | null;
    ExpiresAt: string | null;
}

async function post(route: string, body: unknown): Promise<any> {
    const r = await fetch(`http://localhost:5000${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    return r.json();
}

function HandoffOffer() {
    const nav = useNavigate();
    const [offer, setOffer] = useState<Offer | null>(null);
    const [busy, setBusy] = useState(false);
    const [isMain, setIsMain] = useState<boolean | null>(null);

    const [timerDone] = useSharedState<boolean>("timerDone", true);
    const [currentBuildId] = useSharedState<number | boolean>("currentBuildId", 0);
    const [, setSelectedHarn] = useSharedState<string>("selectedHarn", "");
    const [, setTimerMode] = useSharedState<{ header: string; id: number }>("timerMode", {
        header: "Timing Build",
        id: 1,
    });
    const [, setBatchMode] = useSharedState<boolean>("batchMode", false);
    const [, setBatchUnits] = useSharedState<number>("batchUnits", 1);

    // Read by the poll and the answer timer, which are set up once.
    const live = useRef({ timerDone, currentBuildId, offer });
    live.current = { timerDone, currentBuildId, offer };
    const answerTimer = useRef<number | null>(null);

    // The analytics screen is read from across the shop; a modal there would
    // sit unanswered in front of nobody.
    useEffect(() => {
        let cancelled = false;
        window.electron
            .getWindowType()
            .then((t) => !cancelled && setIsMain(t === "main"))
            .catch(() => !cancelled && setIsMain(false));
        return () => {
            cancelled = true;
        };
    }, []);

    /** Answer a claimed row. Claimed rows are resolved by this app or by nobody. */
    const respond = useCallback(async (handoffId: number, response: string) => {
        try {
            await post("/api/handoff/respond", { handoffId, response });
        } catch (e) {
            // The backend queues it if the database is merely out of reach, so
            // reaching here means something worse; the startup sweep is the
            // backstop either way.
            console.error(`handoff: could not answer ${handoffId} as ${response}`, e);
        }
    }, []);

    const dismiss = useCallback(
        async (response: "DECLINED" | "EXPIRED") => {
            const current = live.current.offer;
            if (answerTimer.current) {
                window.clearTimeout(answerTimer.current);
                answerTimer.current = null;
            }
            setOffer(null);
            if (current) await respond(current.HandoffId, response);
        },
        [respond]
    );

    useEffect(() => {
        if (isMain !== true) return;
        let stopped = false;

        async function poll() {
            const L = live.current;
            // Never interrupt a live build. An offer CAN therefore expire with
            // someone standing right there - the Cirris side has this in
            // writing - because a modal over a running clock is the worse
            // failure. Nor stack a second offer on an unanswered one.
            if (L.offer || !L.timerDone || L.currentBuildId) return;
            try {
                const r = await fetch("http://localhost:5000/api/handoff/pending");
                const data = await r.json();
                const rows: Offer[] = Array.isArray(data?.result) ? data.result : [];
                if (!rows.length || stopped) return;
                const pick = rows[0];
                // Claim BEFORE drawing anything, so two panels cannot both pop
                // the same offer. The loser is told and simply moves on.
                const claim = await post("/api/handoff/claim", { handoffId: pick.HandoffId });
                if (stopped) return;
                if (claim?.result?.claimed !== true) return;
                setOffer(pick);
                answerTimer.current = window.setTimeout(() => { void dismiss("EXPIRED"); }, ANSWER_MS);
            } catch {
                // The backend not answering is not worth reporting here; the
                // timing page already says when the database is unreachable.
            }
        }

        void poll();
        const id = window.setInterval(poll, POLL_MS);
        return () => {
            stopped = true;
            window.clearInterval(id);
            if (answerTimer.current) window.clearTimeout(answerTimer.current);
        };
    }, [isMain, dismiss]);

    async function accept() {
        const current = offer;
        if (!current || busy) return;
        setBusy(true);
        try {
            setSelectedHarn(current.HarnPn);
            // Mode and units come off the ROW, which is more specific than the
            // panel's own default for that mode.
            const mode = timerModes.find((m) => m.id === Number(current.TimeTypeId));
            if (mode) setTimerMode({ header: mode.header, id: mode.id });
            const units = Number(current.BatchUnits);
            if (Number.isFinite(units) && units > 1) {
                setBatchMode(true);
                setBatchUnits(units);
            }
            await respond(current.HandoffId, "ACCEPTED");
            setOffer(null);
            nav("/timer");
        } finally {
            setBusy(false);
        }
    }

    if (!offer) return null;

    const mode = timerModes.find((m) => m.id === Number(offer.TimeTypeId));
    const units = Number(offer.BatchUnits);

    return (
        <div className="handoff-backdrop" role="dialog" aria-modal="true" aria-label="Timer offer">
            <div className="handoff-card">
                <p className="handoff-from">
                    Ready at the test station{offer.FromStation ? ` (${offer.FromStation})` : ""}
                </p>
                <p className="handoff-pn">{offer.HarnPn}</p>
                <ul className="handoff-detail">
                    <li>{mode ? mode.label.replace("Timer Mode: ", "Time it as ") : "Time it as Build"}</li>
                    {Number.isFinite(units) && units > 1 && <li>Batch of {units} units</li>}
                </ul>
                {offer.Note && <p className="handoff-note">{offer.Note}</p>}
                <p className="handoff-hint">
                    Accepting sets this up. It does NOT start the clock - press Start when you are
                    ready.
                </p>
                <div className="handoff-buttons">
                    <button
                        type="button"
                        className="handoff-decline"
                        id="handoff-decline"
                        disabled={busy}
                        onClick={() => void dismiss("DECLINED")}
                    >
                        Not now
                    </button>
                    <button
                        type="button"
                        className="handoff-accept"
                        id="handoff-accept"
                        disabled={busy}
                        onClick={() => void accept()}
                    >
                        Set it up
                    </button>
                </div>
            </div>
        </div>
    );
}

export default HandoffOffer;
