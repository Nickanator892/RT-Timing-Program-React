import "./closeButton.css";

function CloseButton() {
    // Closing used to DROP the shared HARNBUILDTIMES_VIEW, which breaks any
    // other station mid-query; the server recreates the view on every start, so
    // the drop was never needed. Quitting now just quits - and the main
    // process's before-quit handler writes a final heartbeat first, so a build
    // closed mid-run keeps the time it earned and can be resumed on relaunch.
    return (
        <button className="close-button" onClick={() => window.electron.quitApp()}>
            Close
        </button>
    );
}

export default CloseButton;
