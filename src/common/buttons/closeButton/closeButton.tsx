import "./closeButton.css";

function CloseButton() {
    return (
        <button className="close-button" onClick={() => window.electron.quitApp()}>
            Close
        </button>
    );
}

export default CloseButton;
