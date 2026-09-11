import { useRef, useState } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import { useSettings } from "../../hooks/useSettings";
import AnchoredList from "../anchoredList/anchoredList";
import type { User } from "../../assets/types/UserType";
import { recentOperatorsFirst, rememberOperator } from "../../assets/operatorOrder";
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
                    <span className="primary-operator-label">HAND OVER TO</span>
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
                Hand Over...
            </button>
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
