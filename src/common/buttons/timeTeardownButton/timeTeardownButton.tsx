import "./timeTeardownButton.css"
import { useSharedState } from "../../../hooks/useSharedState";

function TimeTeardownButton() {
    const [_timerMode, setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    return (
        <button className="time-teardown-button" onClick={() => setTimerMode({header: "Timing Teardown", id: 3})}>
            Time Teardown
        </button>
    );
}

export default TimeTeardownButton;
