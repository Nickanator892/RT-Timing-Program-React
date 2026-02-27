import "./pausePage.css";
import type { PauseReason } from "../../assets/types/pauseReasonType";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";

type pauseProps = {
    pauseReasons: PauseReason[];
    setPauseReason: React.Dispatch<React.SetStateAction<PauseReason | undefined>>;
    setErr: React.Dispatch<React.SetStateAction<string>>;
    pauseStart: string | null;
    setPauseStart: React.Dispatch<React.SetStateAction<string | null>>;
};

function PausePage({ pauseReasons, setErr }: pauseProps) {
    const [sharedPauseReason, setSharedPauseReason] = useSharedState<PauseReason | undefined>(
        "pauseReason",
        undefined
    );
    const nav = useNavigate();

    function selectPauseReason({ Id, name }: PauseReason) {
        setSharedPauseReason({ Id, name });
        setErr(name);
        nav("/timer");
    }

    return (
        <div id="reasons-list">
            {pauseReasons.map((reason) => (
                <div key={reason.Id}>
                    <p>{reason.name}</p>
                    <button
                        key={reason.Id}
                        type="button"
                        id="choose-reason-button"
                        onClick={() => selectPauseReason({ Id: reason.Id, name: reason.name })}
                    >
                        Choose Reason
                    </button>
                </div>
            ))}
        </div>
    );
}

export default PausePage;
