import "./closeButton.css";

function CloseButton() {

    const execQuery = async (requestedQuery: string, params: unknown[] = []): Promise<any> => {
    try {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: requestedQuery, params }),
        });
        const data = await response.json();

        if (data.success === false) return false;
        return data;
    } catch (err: any) {
        console.log(err);
        return false;
    }
};

    return (
        <button className="close-button" onClick={() => {
            const handleClose = async() => {
                await execQuery(`DROP VIEW IF EXISTS HARNBUILDTIMES_VIEW;`)
                window.electron.quitApp()
            }
            handleClose()
        }
        }>
            Close
        </button>
    );
}

export default CloseButton;
