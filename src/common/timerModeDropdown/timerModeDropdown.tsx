import { useSharedState } from "../../hooks/useSharedState"
import "./timerModeDropdown.css"

const timerModes = [
    { header: "Timing Build", id: 1, label: "Timer Mode: Build" },
    { header: "Timing Setup", id: 2, label: "Timer Mode: Setup" },
    { header: "Timing Teardown", id: 3, label: "Timer Mode: Teardown" },
    { header: "Timing Overmold", id: 5, label: "Timer Mode: Overmold" },
    { header: "Timing Prebuild", id: 6, label: "Timer Mode: Prebuild" },
    { header: "Timing Strip & Crimp", id: 7, label: "Timer Mode: Strip & Crimp" },
    { header: "Timing Braid", id: 8, label: "Timer Mode: Braid" }
];

function TimerModeDropdown() {
    const [timerMode, setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})

    return (
        <select 
            name="Timer Mode" 
            className="timer-mode-dropdown"
            value={timerMode.id}
            onChange={(e) => {
                const mode = timerModes.find((m) => m.id === Number(e.target.value));
                if (mode) setTimerMode({ header: mode.header, id: mode.id });
            }}
        >
            {timerModes.map((mode) => (
                <option key={mode.id} value={mode.id} className="timer-option">
                    {mode.label}
                </option>
            ))}
        </select>
    )
}

export default TimerModeDropdown