import "./settingsButton.css"
import { NavLink } from "react-router-dom"
import settingsIcon from "../../../assets/settingsIcon.png"

function SettingsButton() {
    return (
        <button type="button" className="settings-button">
            <NavLink to="/settings"><img src={settingsIcon} alt="Settings" /></NavLink>
        </button>
    )
}

export default SettingsButton