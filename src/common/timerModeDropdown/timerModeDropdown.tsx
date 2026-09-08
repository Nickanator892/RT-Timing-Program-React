import { useRef, useState } from "react"
import { useSharedState } from "../../hooks/useSharedState"
import AnchoredList from "../anchoredList/anchoredList"
import "./timerModeDropdown.css"

// id 4 is reserved: pause records are stored in HARNBUILDTIMES with
// timeTypeId 4, so new modes must never reuse it.
export const timerModes = [
    { header: "Timing Build", id: 1, label: "Timer Mode: Build" },
    { header: "Timing Setup", id: 2, label: "Timer Mode: Setup" },
    { header: "Timing Teardown", id: 3, label: "Timer Mode: Teardown" },
    { header: "Timing Overmold", id: 5, label: "Timer Mode: Overmold" },
    { header: "Timing Prebuild", id: 6, label: "Timer Mode: Prebuild" },
    { header: "Timing Strip & Crimp", id: 7, label: "Timer Mode: Strip & Crimp" },
    { header: "Timing Braid", id: 8, label: "Timer Mode: Braid" },
    { header: "Timing Final Test", id: 9, label: "Timer Mode: Final Test" }
];

// Was a native <select>, whose popup opened off the bottom of the bench panel
// with no way to scroll it - every mode past Overmold was unreachable. The list
// is AnchoredList now, which keeps itself on screen.
function TimerModeDropdown() {
    const [timerMode, setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    const [open, setOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    const current = timerModes.find((m) => m.id === timerMode.id) ?? timerModes[0];

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
                <span className="timer-mode-current">{current.label}</span>
                <span className="timer-mode-caret" aria-hidden="true">{open ? "▲" : "▼"}</span>
            </button>

            {open && (
                <AnchoredList
                    anchorRef={buttonRef}
                    ariaLabel="Timer mode"
                    items={timerModes.map((m) => ({
                        key: m.id,
                        label: m.label.replace("Timer Mode: ", ""),
                        selected: m.id === timerMode.id,
                    }))}
                    onPick={(key) => {
                        const mode = timerModes.find((m) => m.id === Number(key));
                        if (mode) setTimerMode({ header: mode.header, id: mode.id });
                        setOpen(false);
                        buttonRef.current?.focus();
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
