import "./chooseKitButton.css"
import { useNavigate } from "react-router-dom"
import chooseKitIcon from "../../../assets/kitIcon.png"
import { requestGuardedChange } from "../../carryoverLock/carryoverLock"

// See chooseHarnessButton.tsx - same carryover-lock reasoning, "job" kind.
function ChooseKitButton() {
    const nav = useNavigate();
    return (
        <button
            type="button"
            className="choose-harness-button"
            onClick={() => requestGuardedChange("job", () => nav("/choose-kit"))}
        >
            <img src={chooseKitIcon} alt="choose-harn" />
        </button>
    )
}

export default ChooseKitButton
