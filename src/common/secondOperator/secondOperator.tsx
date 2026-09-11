import { useRef, useState } from "react"
import { useSharedState } from "../../hooks/useSharedState"
import { useSettings } from "../../hooks/useSettings"
import AnchoredList from "../anchoredList/anchoredList"
import { recentOperatorsFirst, rememberOperator } from "../../assets/operatorOrder"
import "./secondOperator.css"

interface User {
    Id: number;
    name: string;
}

/**
 * Second operator on the bench.
 *
 * Two people on one harness earn two people's time, so a segment worked by a
 * pair is recorded with numberOfBuilders = 2 and counts DOUBLE (see
 * HARNBUILDTIMES_VIEW.laborSeconds). Adding or dropping someone mid-run rolls
 * the segment (timingPage's builder-change effect), so the single-crewed and
 * double-crewed stretches of one build are separate rows carrying their own
 * rate - the switch back down is recorded, not smeared over the whole build.
 *
 * The badge flashes because the cost of forgetting is silent and expensive: a
 * pair left loaded after one of them walks away bills every later harness at
 * twice the labour. timingPage clears it on submit, on a harness change and on
 * clock-out for the same reason.
 */
function SecondOperator() {
    const { users } = useSettings();
    const [selectedUser] = useSharedState<User | undefined>("selectedUser", undefined);
    const [secondaryBuilders, setSecondaryBuilders] = useSharedState<{ Id: Number; name: string }[]>(
        "secondaryBuilders",
        []
    );
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const second = secondaryBuilders[0];

    // Anyone active except whoever is already on this timer, the people who
    // work this bench first.
    const candidates = recentOperatorsFirst(
        (users ?? []).filter(
            (u: User) =>
                Number(u.Id) !== Number(selectedUser?.Id ?? -1) &&
                !secondaryBuilders.some((s) => Number(s.Id) === Number(u.Id))
        )
    );

    if (second) {
        return (
            <div className="second-operator loaded">
                <div className="second-operator-badge" role="status">
                    <span className="second-operator-label">2ND OPERATOR</span>
                    <span className="second-operator-name">{second.name}</span>
                    <span className="second-operator-rate">recording 2&times; time</span>
                </div>
                <button
                    type="button"
                    className="second-operator-drop"
                    onClick={() => setSecondaryBuilders((prev) => prev.filter((u) => Number(u.Id) !== Number(second.Id)))}
                >
                    Drop 2nd Operator
                </button>
            </div>
        );
    }

    return (
        <div className="second-operator">
            <button
                type="button"
                ref={buttonRef}
                className="second-operator-add"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                + Add 2nd Operator
            </button>
            {open && (
                <AnchoredList
                    anchorRef={buttonRef}
                    ariaLabel="Second operator"
                    className="operator-panel"
                    emptyText="No other builders active"
                    items={candidates.map((u: User) => ({ key: u.Id, label: u.name }))}
                    onPick={(key) => {
                        const picked = candidates.find((u: User) => Number(u.Id) === Number(key));
                        if (picked) {
                            rememberOperator(picked.Id);
                            setSecondaryBuilders((prev) => [...prev, { Id: picked.Id, name: picked.name }]);
                        }
                        setOpen(false);
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}

export default SecondOperator
