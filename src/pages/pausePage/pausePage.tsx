import "./pausePage.css"
import type { PauseReason } from "../../assets/types/pauseReasonType"
import { useNavigate } from "react-router-dom"

type pauseProps = {
    pauseReasons: PauseReason[],
    setPauseReason: React.Dispatch<React.SetStateAction<PauseReason[]>>,
    setErr: React.Dispatch<React.SetStateAction<string>>
}

function PausePage({ pauseReasons, setPauseReason, setErr }: pauseProps) {
    const nav = useNavigate()

    function selectPauseReason({ Id, name }: PauseReason) {
        setPauseReason([{Id, name}])
        setErr(name)
        nav("/")
    }

    return(
        <div id="reasons-list"> 
            {pauseReasons.map(reason => (
                <div key={reason.Id}>
                    <p>{reason.name}</p>
                    <button key={reason.Id} type="button" id="choose-reason-button" onClick={() => selectPauseReason({Id: reason.Id, name: reason.name})}>Choose Reason</button>
                </div>
            ))}
        </div>
    )
}

export default PausePage