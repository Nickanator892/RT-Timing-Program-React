import "./chooseHarnPage.css"
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import useTimes from "../../hooks/loggedTimesHook";

interface harnProps {
    setHarn: React.Dispatch<React.SetStateAction<string>>;
}

function ChooseHarnPage({ setHarn }: harnProps) {
    const nav = useNavigate();
    const tempHarns = ["HYSV-10001-R5", "HYSV-10002-R2", "HYSV-10003-R1", "HYSV-10004-R2", "HYSV-10005-R6"]

    const [currentPage, setCurrentPage] = useState(0);
    const itemsPerPage = 4;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = tempHarns.length > endIndex;
    const hasPreviousPage = currentPage > 0;

    function selectHarn(harnNumber: string) {
        let selectedHarn = undefined;
        tempHarns.map((harn) => {
            if (harn == harnNumber) {
                selectedHarn = harn;
            }
        });
        if (selectedHarn != undefined) {
            console.log(selectedHarn)
            setHarn(selectedHarn);
            setTimeout(() => {
                nav("/timer");
            }, 500);
            handleOpenAnalytics()
            useTimes().fetchTimes(selectedHarn)
        }
    }

    const handleOpenAnalytics = () => {
        window.electron.openAnalyticsWindow();
    };


    function nextPage() {
        if (hasNextPage) {
            setCurrentPage((prev) => prev + 1);
        }
    }

    function previousPage() {
        if (hasPreviousPage) {
            setCurrentPage((prev) => prev - 1);
        }
    }
    
    return (
        <div>
        <h2 className="harn-choice-header">Select Harness</h2>
        <div id="harn-list">
            {tempHarns.slice(startIndex, endIndex).map((harn) => (
                <div key={harn}>
                    <p>{harn}</p>
                    <button type="button" onClick={() => selectHarn(harn)}>
                        Choose
                    </button>
                </div>
            ))}
        </div>
        <div className="pagination-buttons">
            <button type="button" onClick={previousPage} disabled={!hasPreviousPage}>
                Previous
            </button>
            <button type="button" onClick={nextPage} disabled={!hasNextPage}>
                Next
            </button>
        </div>
    </div>
    )
}

export default ChooseHarnPage