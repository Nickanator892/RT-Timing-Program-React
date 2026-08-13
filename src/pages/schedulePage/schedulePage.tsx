import "./schedulePage.css";
import { useEffect, useState } from "react";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";

const API_BASE = "http://localhost:5000";
const FALLBACK_SCHEDULE_URL = "http://192.168.0.199:8322/schedule";

// Master production schedule board, served by HPP's RT-MCS service on the LAN
// (read-only view; the board itself owns editing behind its own login). The
// URL comes from db-config.json's "scheduleUrl" via /api/config so a Pi can be
// repointed without a rebuild.
function SchedulePage() {
    const [scheduleUrl, setScheduleUrl] = useState<string>(FALLBACK_SCHEDULE_URL);

    useEffect(() => {
        fetch(`${API_BASE}/api/config`)
            .then((res) => res.json())
            .then((data: { scheduleUrl?: string }) => {
                if (data.scheduleUrl) setScheduleUrl(data.scheduleUrl);
            })
            .catch(() => {
                /* keep fallback */
            });
    }, []);

    return (
        <div className="schedule-page">
            <iframe
                className="schedule-frame"
                src={scheduleUrl}
                title="Master Production Schedule"
            />
            <div id="nav-buttons">
                <TimerButton />
                <SettingsButton />
                <ChooseHarnessButton />
                <ChooseKitButton />
            </div>
        </div>
    );
}

export default SchedulePage;
