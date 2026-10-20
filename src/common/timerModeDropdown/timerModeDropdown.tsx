import { useRef, useState } from "react"
import { useSharedState } from "../../hooks/useSharedState"
import AnchoredList from "../anchoredList/anchoredList"
import { requestGuardedChange } from "../carryoverLock/carryoverLock"
import { PREBUILD_MODE, useHarnSteps, type PrebuildShare } from "../../hooks/useHarnSteps"
import "./timerModeDropdown.css"

// id 4 is reserved: pause records are stored in HARNBUILDTIMES with
// timeTypeId 4, so new modes must never reuse it. id 10 is reserved too: it was
// "Bobbin Change" for a day (1.0.22) before Randy moved bobbin changes onto the
// Braid screen as a side timer (2026-09-14) - braiding time, tracked apart.
// id 11 is Packaging: a finishing step after Final Test, per unit or batch. It
// has no pricing target and never counts as a built harness (only Build, id 1,
// does), so the analytics screen draws no Build estimate for it.
// id 12 is Test: the pre-overmold test of a single-cable harness (Harness
// Steps, Randy 2026-10-20) - the same id and name as RT-MCS Db.TimerModes.
export const PACKAGING_MODE = 11;
export const TEST_MODE = 12;
export const timerModes = [
    { header: "Timing Build", id: 1, label: "Timer Mode: Build" },
    { header: "Timing Setup", id: 2, label: "Timer Mode: Setup" },
    { header: "Timing Teardown", id: 3, label: "Timer Mode: Teardown" },
    { header: "Timing Overmold", id: 5, label: "Timer Mode: Overmold" },
    { header: "Timing Prebuild", id: 6, label: "Timer Mode: Prebuild" },
    { header: "Timing Strip & Crimp", id: 7, label: "Timer Mode: Strip & Crimp" },
    { header: "Timing Braid", id: 8, label: "Timer Mode: Braid" },
    { header: "Timing Final Test", id: 9, label: "Timer Mode: Final Test" },
    { header: "Timing Packaging", id: PACKAGING_MODE, label: "Timer Mode: Packaging" },
    { header: "Timing Test", id: TEST_MODE, label: "Timer Mode: Test" }
];

/** The shared prebuild pick's list key - not a time type id. */
const SHARED_PREBUILD_KEY = "shared-prebuild";

/** "HYSV-20008 + HYSV-20009 (shared prebuild)" */
export const sharedPrebuildLabel = (members: string[]) => `${members.join(" + ")} (shared prebuild)`;

// Was a native <select>, whose popup opened off the bottom of the bench panel
// with no way to scroll it - every mode past Overmold was unreachable. The list
// is AnchoredList now, which keeps itself on screen.
function TimerModeDropdown() {
    const [timerMode, setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    const [selectedHarn] = useSharedState<string>("selectedHarn", "")
    const [prebuildShare, setPrebuildShare] = useSharedState<PrebuildShare | null>("prebuildShare", null)
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    // Harness Steps (Randy 2026-10-20): the revision's required steps first,
    // in shop order, then the rest as before. No rows (the tables start
    // empty), or none readable: today's full list.
    const steps = useHarnSteps(selectedHarn);

    const current = timerModes.find((m) => m.id === timerMode.id) ?? timerModes[0];
    const sharing = timerMode.id === PREBUILD_MODE && !!prebuildShare && prebuildShare.harn === selectedHarn;

    const required = steps?.required ?? [];
    const ordered = [
        ...required.map((id) => timerModes.find((m) => m.id === id)).filter((m) => !!m),
        ...timerModes.filter((m) => !required.includes(m.id)),
    ];
    const items: { key: string | number; label: string; selected: boolean }[] = [];
    for (const m of ordered) {
        const name = m.label.replace("Timer Mode: ", "");
        items.push({
            key: m.id,
            label: required.includes(m.id) ? `${name} - required` : name,
            selected: m.id === timerMode.id && !(m.id === PREBUILD_MODE && sharing),
        });
        // A shared prebuild group: one session for every harness in it, right
        // under Prebuild (design section 5).
        if (m.id === PREBUILD_MODE && steps && steps.members.length >= 2) {
            items.push({ key: SHARED_PREBUILD_KEY, label: sharedPrebuildLabel(steps.members), selected: sharing });
        }
    }

    return (
        <>
            <button
                type="button"
                ref={buttonRef}
                className="timer-mode-dropdown"
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
            >
                <span className="timer-mode-current">
                    {/* The harnesses are on the note under the button (timingPage). */}
                    {sharing ? "Timer Mode: Prebuild (shared)" : current.label}
                </span>
                <span className="timer-mode-caret" aria-hidden="true">{open ? "▲" : "▼"}</span>
            </button>

            {open && (
                <AnchoredList
                    anchorRef={buttonRef}
                    ariaLabel="Timer mode"
                    className="timer-mode-panel"
                    items={items}
                    onPick={(key) => {
                        const shared = key === SHARED_PREBUILD_KEY && steps?.group ? steps : null;
                        const mode = timerModes.find((m) => m.id === (shared ? PREBUILD_MODE : Number(key)));
                        setOpen(false);
                        buttonRef.current?.focus();
                        // Randy, 2026-09-25: a mode change is a different
                        // operation just like a harness or job change, so it
                        // goes through the same unsubmitted-time lock.
                        if (mode) requestGuardedChange("mode", () => {
                            setPrebuildShare(shared ? { harn: selectedHarn, group: shared.group!, members: shared.members } : null);
                            setTimerMode({ header: mode.header, id: mode.id });
                        });
                    }}
                    onClose={() => {
                        setOpen(false);
                        buttonRef.current?.focus();
                    }}
                />
            )}
        </>
    )
}

export default TimerModeDropdown
