import "./chooseKitPage.css";
import { useState } from "react";
import { useBuildKit } from "../../hooks/useBuildKit";
import type { BuildKit } from "../../hooks/useBuildKit";
import { useNavigate } from "react-router-dom";

function ChooseKitPage() {
    const nav = useNavigate();
    const { buildKits, fetchKit } = useBuildKit();

    const [currentPage, setCurrentPage] = useState(0);
    const [selectedRevContents, setSelectedRevContents] = useState<BuildKit | null>(null);
    const [modalPage, setModalPage] = useState(0);

    const itemsPerPage = 4;
    const modalItemsPerPage = 12;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = buildKits ? buildKits.length > endIndex : false;
    const hasPreviousPage = currentPage > 0;

    const modalStartIndex = modalPage * modalItemsPerPage;
    const modalEndIndex = modalStartIndex + modalItemsPerPage;
    const modalHasNext = selectedRevContents
        ? selectedRevContents.harnesses.length > modalEndIndex
        : false;
    const modalHasPrev = modalPage > 0;

    async function selectKit(rev: number) {
        const kit = await fetchKit(rev);
        if (kit) {
            nav("/choose-harn");
        }
    }

    async function viewRevContents(rev: number) {
        const kit = await fetchKit(rev);
        if (kit) {
            setModalPage(0); // Reset to first page when opening a new kit
            setSelectedRevContents(kit);
        }
    }

    function closeModal() {
        setSelectedRevContents(null);
        setModalPage(0);
    }

    function nextPage() {
        if (hasNextPage) setCurrentPage((prev) => prev + 1);
    }

    function previousPage() {
        if (hasPreviousPage) setCurrentPage((prev) => prev - 1);
    }

    function generateKitList() {
        if (buildKits) {
            return buildKits.slice(startIndex, endIndex).map((kit) => (
                <div key={kit.REV}>
                    <p>{kit.REV}</p>
                    <button type="button" onClick={() => viewRevContents(kit.REV)}>
                        View Contents
                    </button>
                    <button type="button" onClick={() => selectKit(kit.REV)}>
                        Choose
                    </button>
                </div>
            ));
        }
    }

    return (
        <div>
            {selectedRevContents && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h3>REV: {selectedRevContents.REV}</h3>
                        <div>
                            {selectedRevContents.harnesses
                                .slice(modalStartIndex, modalEndIndex)
                                .map((harness) => (
                                    <p key={harness.partNum}>
                                        {harness.partNum} / {harness.buildNumber}
                                    </p>
                                ))}
                        </div>
                        <div className="modal-buttons">
                            <button
                                type="button"
                                onClick={() => setModalPage((prev) => prev - 1)}
                                disabled={!modalHasPrev}
                            >
                                Previous
                            </button>
                            <span>
                                {modalPage + 1} /{" "}
                                {Math.ceil(
                                    selectedRevContents.harnesses.length / modalItemsPerPage
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => setModalPage((prev) => prev + 1)}
                                disabled={!modalHasNext}
                            >
                                Next
                            </button>
                            <button type="button" onClick={closeModal}>
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <h2 className="harn-choice-header">Select Kit REV</h2>
            <div id="harn-list">{generateKitList()}</div>
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

export default ChooseKitPage;
