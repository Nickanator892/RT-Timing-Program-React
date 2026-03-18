import "./checkForUpdateElement.css"

declare const __APP_VERSION__: string;
function CheckForUpdateElement() {
    function checkForUpdate() {
        window.electron.runUpdater();
    }
    return (
        <div id="update-element">
            <button id="update-check-button" onClick={checkForUpdate}>Check For Update (App will Restart)</button>
            <p>Current Version: v{__APP_VERSION__}</p>
        </div>
    )
}

export default CheckForUpdateElement