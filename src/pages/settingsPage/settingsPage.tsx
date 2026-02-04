import { useState } from "react"
import useSettings from "../../hooks/pauseReasonHook"
import "./settingsPage.css"
import TimerButton from "../../common/timerButton/timerButton"
import SettingsButton from "../../common/settingsButton/settingsButton"

function SettingsPage() {
    const { pauseReasons, loading, addPauseReason, removePauseReason } = useSettings()
    const [inputValue, setInputValue] = useState("")
    const [err, setErr] = useState("")

    if (loading) return <p>Loading...</p>
    
    function saveReason() {
        if (inputValue.trim() != "") {
            addPauseReason(inputValue)
            setErr("")
        } else {
            setErr("Must enter a reason")
        }
    }

    return (
        <div>
            <div id="nav-buttons">
                    <TimerButton/>
                    <SettingsButton/>
                </div>
        <div className="pause-reasons">
            
            <div className="add-pause-reason-form">
                <h2>Pause Reasons</h2>
                <input type="text" name="Pause-reason-input" id="reason-text-input" placeholder="Pause reason" onChange={(e) => setInputValue(e.target.value)} />
                <button id="add-reason-button" type="button" onClick={saveReason}>Add Pause Reason</button>
            </div>
            <div id="reasons-list"> 
                {pauseReasons.map(reason => (
                    <div>
                        <p>{reason.name}</p>
                        <button type="button" key={reason.Id} onClick={() => removePauseReason(reason.Id)}>Remove Reason</button>
                    </div>
                ))}
            </div>
            <p id="error-message">{err}</p>
            </div>
            </div>
    )
}

export default SettingsPage