import "./timeSetupButton.css"
import { useSharedState } from "../../../hooks/useSharedState";

function TimeSetupButton() {
    const [_timerMode, setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    return (
        <button className="time-setup-button" onClick={() => setTimerMode({header: "Timing Setup", id: 2})}>
            Time Setup
        </button>
    );
}

export default TimeSetupButton;
