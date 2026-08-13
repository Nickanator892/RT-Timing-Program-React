import "./scheduleButton.css";
import { NavLink } from "react-router-dom";

// Text-styled nav button (no icon asset yet - swap the inline SVG for a PNG in
// assets/ to match the other buttons whenever one exists).
function ScheduleButton() {
    return (
        <button type="button" className="schedule-button">
            <NavLink to="/schedule" aria-label="schedule">
                <svg viewBox="0 0 24 24" width="4.5em" height="4.5em" fill="none"
                     stroke="currentColor" strokeWidth="1.6">
                    <rect x="3" y="5" width="18" height="16" rx="2" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                    <line x1="8" y1="3" x2="8" y2="7" />
                    <line x1="16" y1="3" x2="16" y2="7" />
                    <line x1="7" y1="14" x2="13" y2="14" />
                    <line x1="7" y1="17" x2="17" y2="17" />
                </svg>
            </NavLink>
        </button>
    );
}

export default ScheduleButton;
