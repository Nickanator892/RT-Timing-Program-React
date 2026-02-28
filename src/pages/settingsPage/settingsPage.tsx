import { useState } from "react";
import useSettings from "../../hooks/pauseReasonHook";
import "./settingsPage.css";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import type { User } from "../../assets/types/UserType";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";

interface settingsPageProps {
    selectedUser: User | undefined;
}

function SettingsPage({ selectedUser }: settingsPageProps) {
    const { users, pauseReasons, loading, addPauseReason, removePauseReason, addUser, deleteUser } =
        useSettings();
    const [inputValue, setInputValue] = useState("");
    const [userInput, setUserInput] = useState("");
    const [err, setErr] = useState("");
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [userToDelete, setUserToDelete] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState(0);
    const itemsPerPage = 5;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = users.length > endIndex;
    const hasPreviousPage = currentPage > 0;

    if (loading) return <p>Loading...</p>;

    function saveReason() {
        if (inputValue.trim() != "") {
            addPauseReason(inputValue);
            setErr("");
        } else {
            setErr("Must enter a reason");
        }
    }

    function saveUser() {
        if (userInput.trim() != "") {
            addUser(userInput);
            setErr("");
        } else {
            setErr("Must enter username");
        }
    }

    function removeUser(id: number) {
        if (id == selectedUser?.Id) {
            setErr("Cannot delete current user");
            return;
        }
        setUserToDelete(id);
        setShowDeleteModal(true);
    }

    function confirmDelete() {
        if (userToDelete !== null) {
            deleteUser(userToDelete);
            setShowDeleteModal(false);
            setUserToDelete(null);
        }
    }

    function cancelDelete() {
        setShowDeleteModal(false);
        setUserToDelete(null);
    }

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
        <div className="settings-page">
            {/* Modal */}
            {showDeleteModal && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h3>Confirm Delete</h3>
                        <p>Are you sure you want to delete this user?</p>
                        <div className="modal-buttons">
                            <button onClick={confirmDelete}>Yes, Delete</button>
                            <button onClick={cancelDelete}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            <div id="nav-buttons">
                <TimerButton />
                <SettingsButton />
                <ChooseHarnessButton />
                <ChooseKitButton />
            </div>

            <div className="pause-reasons">
                <div className="add-pause-reason-form">
                    <h2>Pause Reasons</h2>
                    <input
                        type="text"
                        name="Pause-reason-input"
                        id="reason-text-input"
                        placeholder="Pause reason"
                        onChange={(e) => setInputValue(e.target.value)}
                    />
                    <button id="add-reason-button" type="button" onClick={saveReason}>
                        Add Pause Reason
                    </button>
                </div>
                <div id="reasons-list">
                    {pauseReasons.map((reason) => (
                        <div key={reason.Id}>
                            <p>{reason.name}</p>
                            <button type="button" onClick={() => removePauseReason(reason.Id)}>
                                Remove Reason
                            </button>
                        </div>
                    ))}
                </div>
            </div>

            <div className="user-selection">
                <div className="add-user-form">
                    <h2>User Management</h2>
                    <input
                        type="text"
                        name="user-add-input"
                        id="user-add-input"
                        placeholder="firstName-lastName"
                        onChange={(e) => setUserInput(e.target.value)}
                    />
                    <button type="button" onClick={saveUser}>
                        Add User
                    </button>
                </div>
                <div id="users-list">
                    {users.slice(startIndex, endIndex).map((user) => (
                        <div key={user.Id}>
                            <p>{user.name}</p>
                            <button type="button" onClick={() => removeUser(user.Id)}>
                                Remove User
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

            <p id="error-message">{err}</p>
            <div id="RT-logo">
                <p id="RT-part-one">RT </p> <p id="RT-part-two">Technologies</p>
            </div>
        </div>
    );
}

export default SettingsPage;
