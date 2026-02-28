import "./chooseHarnPage.css";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import useTimes from "../../hooks/loggedTimesHook";
import { useBuildKit } from "../../hooks/useBuildKit";

interface harnProps {
    setHarn: React.Dispatch<React.SetStateAction<string>>;
}

function ChooseHarnPage({ setHarn }: harnProps) {
    const nav = useNavigate();
    const { buildKit } = useBuildKit();
    const { fetchTimes } = useTimes();

    const [currentPage, setCurrentPage] = useState(0);
    const itemsPerPage = 4;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    let hasNextPage = false;
    if (buildKit) {
        hasNextPage = buildKit.harnesses.length > endIndex;
    }

    const hasPreviousPage = currentPage > 0;

    function selectHarn(harnNumber: string) {
        let selectedHarn = undefined;
        if (buildKit) {
            buildKit.harnesses.map((harn) => {
                if (harn.partNum == harnNumber) {
                    selectedHarn = harn.partNum;
                }
            });
            if (selectedHarn != undefined) {
                setHarn(selectedHarn);
                setTimeout(() => {
                    nav("/timer");
                }, 500);
                handleOpenAnalytics();
                fetchTimes(selectedHarn);
            }
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
                {buildKit?.harnesses.slice(startIndex, endIndex).map((harn) => (
                    <div key={harn.partNum}>
                        <p>{harn.partNum}</p>
                        <button type="button" onClick={() => selectHarn(harn.partNum)}>
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
    );
}

export default ChooseHarnPage;
