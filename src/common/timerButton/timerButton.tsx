import "./timerButton.css";
import { NavLink } from "react-router-dom";
import timerIcon from "../../assets/timerIcon.png";

function TimerButton() {
    return (
        <button type="button" className="timer-button">
            <NavLink to="/timer">
                <img src={timerIcon} alt="Timer" />
            </NavLink>
        </button>
    );
}

export default TimerButton;
