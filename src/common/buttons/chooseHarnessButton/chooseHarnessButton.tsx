import "./chooseHarnessButton.css"
import { NavLink } from "react-router-dom"
import chooseHarnIcon from "../../../assets/harnessIcon.png"

function ChooseHarnessButton() {
    return (
        <button type="button" className="choose-harness-button">
            <NavLink to="/choose-harn"><img src={chooseHarnIcon} alt="choose-harn" /></NavLink>
        </button>
    )
}

export default ChooseHarnessButton