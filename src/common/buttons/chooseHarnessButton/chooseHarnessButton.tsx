import "./chooseHarnessButton.css"
import { useNavigate } from "react-router-dom"
import chooseHarnIcon from "../../../assets/harnessIcon.png"
import { requestGuardedChange } from "../../carryoverLock/carryoverLock"

// Randy, 2026-09-25: browsing the harness list is how a harness gets changed
// (chooseHarnPage.selectHarn), so leaving this on a plain NavLink is what let
// the 09-24/25 carryover bug happen - nothing stopped a tap here while the
// PREVIOUS harness still had unsubmitted time on the clock. Navigation is now
// gated behind the same lock the mode dropdown and the kit icon use.
function ChooseHarnessButton() {
    const nav = useNavigate();
    return (
        <button
            type="button"
            className="choose-harness-button"
            onClick={() => requestGuardedChange("harness", () => nav("/choose-harn"))}
        >
            <img src={chooseHarnIcon} alt="choose-harn" />
        </button>
    )
}

export default ChooseHarnessButton
