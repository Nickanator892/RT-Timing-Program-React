import "./timeBuildButton.css"
import { useSharedState } from "../../../hooks/useSharedState";

function TimeBuildButton() {
    const [_timerMode, setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    return (
        <button className="time-build-button" onClick={() => setTimerMode({header: "Timing Build", id: 1})}>
            Time Build
        </button>
    );
}

export default TimeBuildButton;
