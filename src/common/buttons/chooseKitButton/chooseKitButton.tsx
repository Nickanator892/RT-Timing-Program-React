import "./chooseKitButton.css"
import { NavLink } from "react-router-dom"
import chooseKitIcon from "../../../assets/kitIcon.png"

function ChooseKitButton() {
    return (
        <button type="button" className="choose-harness-button">
            <NavLink to="/choose-kit"><img src={chooseKitIcon} alt="choose-harn" /></NavLink>
        </button>
    )
}

export default ChooseKitButton