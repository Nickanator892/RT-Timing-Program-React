import { useRef, useState } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import { useSettings } from "../../hooks/useSettings";
import AnchoredList from "../anchoredList/anchoredList";
import type { User } from "../../assets/types/UserType";
import { recentOperatorsFirst, rememberOperator } from "../../assets/operatorOrder";
import { useTimerFeatures } from "../../hooks/useTimerFeatures";
import "./primaryOperator.css";

/**
 * Who the build belongs to, and the way to hand it to someone else mid-run.
 *
 * Randy, 2026-09-11. Before this the builder was fixed at login: when a harness
 * was passed to another person part-way through - a shift ending, someone
 * pulled onto a hotter job - the only ways out were to leave it recorded
 * against whoever started it, or to submit early and start a second build of
 * the same unit. Neither is the truth, and the second one counts the harness
 * twice.
 *
 * A handover rolls the segment (timingPage's builder-change effect), so the
 * stretch each person worked is its own row carrying its own builderId, and
 * HARNBUILDSEGMENTS is where that split lives. The build row follows whoever is
 * on it now, so "who is building this" stays answerable at a glance.
 *
 * The incoming builder types their own password if they have one - the same bar
 * as logging in, because this decides whose name the work is recorded under.
 */
function PrimaryOperator() {
    const { users } = useSettings();
    const [selectedUser, setSelectedUser] = useSharedState<User | undefined>(
        "selectedUser",
        undefined
    );
    const [secondaryBuilders, setSecondaryBuilders] = useSharedState<{ Id: Number; name: string }[]>(
        "secondaryBuilders",
        []
    );
    // Randy 2026-10-16, both off by default (useTimerFeatures):
    // Timer:SharedSessions - the builder can LEAVE a time others are still on;
    // it hands over to whoever has been on it longest (the first on the
    // roster, RT-MCS FloorLeave), with no password: they are already on it.
    // Timer:PausedFree - handing a PAUSED build to someone who is not on it is
    // a takeover (timingPage handleBuilderChange), so it says so.
    const features = useTimerFeatures();
    const [timerDone] = useSharedState<boolean>("timerDone", true);
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const [pauseStart] = useSharedState<string | null>("pauseStart", null);
    const canLeave = features.sharedSessions && !timerDone && secondaryBuilders.length > 0;
    const takingOver = features.pausedFree && !timerDone && !isRunning && !!pauseStart;

    function leave() {
        const next = secondaryBuilders[0];
        const full = (users ?? []).find((u: User) => Number(u.Id) === Number(next?.Id));
        if (!next || !full) return;
        setSecondaryBuilders((prev) => prev.filter((s) => Number(s.Id) !== Number(next.Id)));
        setSelectedUser(full);
        setOpen(false);
    }
    const [open, setOpen] = useState(false);
    /** Picked, but not yet through their password. */
    const [pending, setPending] = useState<User | null>(null);
    const [password, setPassword] = useState("");
    const [err, setErr] = useState("");
    const buttonRef = useRef<HTMLButtonElement>(null);

    // Anyone active except whoever already has it, the people who work this
    // bench first.
    const candidates = recentOperatorsFirst(
        (users ?? []).filter((u: User) => Number(u.Id) !== Number(selectedUser?.Id ?? -1))
    );

    function handOver(to: User) {
        rememberOperator(to.Id);
        // Nobody is the builder AND the second operator: that is one pair of
        // hands recorded as two, and the segment would bill at double.
        setSecondaryBuilders((prev) => prev.filter((s) => Number(s.Id) !== Number(to.Id)));
        setSelectedUser(to);
        setPending(null);
        setPassword("");
        setErr("");
    }

    function cancel() {
        setPending(null);
        setPassword("");
        setErr("");
    }

    if (pending) {
        return (
            <div className="primary-operator handing-over">
                <div className="primary-operator-prompt">
                    <span className="primary-operator-label">{takingOver ? "TAKE OVER AS" : "HAND OVER TO"}</span>
                    <span className="primary-operator-name">{pending.name}</span>
                </div>
                <input
                    type="password"
                    className="primary-operator-password"
                    id="primary-operator-password"
                    placeholder="Password"
                    value={password}
                    autoFocus
                    onChange={(e) => setPassword(e.target.value)}
                />
                <button
                    type="button"
                    className="primary-operator-confirm"
                    onClick={() => {
                        if (password === pending.password) handOver(pending);
                        else setErr("Incorrect password");
                    }}
                >
                    Take Over
                </button>
                <button type="button" className="primary-operator-cancel" onClick={cancel}>
                    Cancel
                </button>
                {err && <p className="primary-operator-error">{err}</p>}
            </div>
        );
    }

    return (
        <div className="primary-operator">
            <div className="primary-operator-badge">
                <span className="primary-operator-label">BUILDER</span>
                <span className="primary-operator-name">{selectedUser?.name ?? "Not signed in"}</span>
            </div>
            <button
                type="button"
                ref={buttonRef}
                className="primary-operator-switch"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                {takingOver ? "Take Over..." : "Hand Over..."}
            </button>
            {canLeave && (
                <button type="button" className="primary-operator-switch primary-operator-leave" onClick={leave}>
                    Leave
                </button>
            )}
            {open && (
                <AnchoredList
                    anchorRef={buttonRef}
                    ariaLabel="Hand the build over to"
                    className="operator-panel"
                    emptyText="No other builders active"
                    items={candidates.map((u: User) => ({ key: u.Id, label: u.name }))}
                    onPick={(key) => {
                        const picked = candidates.find((u: User) => Number(u.Id) === Number(key));
                        setOpen(false);
                        if (!picked) return;
                        if (picked.password) {
                            setPending(picked);
                            setPassword("");
                            setErr("");
                            return;
                        }
                        handOver(picked);
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}

export default PrimaryOperator;
