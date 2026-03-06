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

//FIX PRIV VALIDATION ISSUE

function SettingsPage({ selectedUser }: settingsPageProps) {
    const { users, pauseReasons, loading, addPauseReason, removePauseReason, addUser, deleteUser } =
        useSettings();
    const [inputValue, setInputValue] = useState("");
    const [userInput, setUserInput] = useState("");
    const [err, setErr] = useState("");
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [userToDelete, setUserToDelete] = useState<{ id: number; name: string } | null>(null);
    const [currentPage, setCurrentPage] = useState(0);
    const [privLevelSelect, setPrivLevelSelect] = useState<number>(3);
    const [password, setPassword] = useState<string>("");
    const itemsPerPage = 5;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = users.length > endIndex;
    const hasPreviousPage = currentPage > 0;

    if (loading) return <p>Loading...</p>;

    function validatePriv(requiredLevel: number) {
        if (selectedUser) {
            const userPrivLevel = selectedUser.privLevel;
            if (userPrivLevel == null) {
                const privLevel = 3;
                if (privLevel > requiredLevel) {
                    setErr("Insufficient Privileges");
                    setTimeout(() => {
                        setErr("");
                    }, 2000);

                    return false;
                } else return true;
            }
            if (selectedUser.privLevel) {
                if (selectedUser?.privLevel > requiredLevel) {
                    setErr("Insufficient Privileges");
                    return false;
                } else if (selectedUser?.privLevel <= requiredLevel) {
                    setErr("");
                    return true;
                }
            }
        }
    }

    function saveReason() {
        if (selectedUser?.privLevel) {
            const validated = validatePriv(2);
            if (!validated) {
                return;
            }
        }

        if (inputValue.trim() != "") {
            addPauseReason(inputValue);
            setErr("");
        } else {
            setErr("Must enter a reason");
        }
    }

    function saveUser() {
        const validated = validatePriv(2);
        console.log(validated);
        if (!validated) {
            return;
        }

        if (userInput.trim() != "") {
            addUser(userInput, privLevelSelect, password);
            setErr("");
        } else {
            setErr("Must enter username");
        }
    }

    function removeUser(id: number, name: string) {
        if (selectedUser) {
            const validated = validatePriv(1);
            if (!validated) {
                return;
            }
        }
        if (id == selectedUser?.Id) {
            setErr("Cannot delete current user");
            return;
        }
        setUserToDelete({ id, name });
        setShowDeleteModal(true);
    }

    function confirmDelete() {
        if (userToDelete !== null) {
            deleteUser(userToDelete.name, userToDelete.id);
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
                    <button
                        id="add-reason-button"
                        type="button"
                        onClick={() => {
                            const validated = validatePriv(2);
                            if (!validated) {
                                return;
                            }
                            saveReason();
                        }}
                    >
                        Add Pause Reason
                    </button>
                </div>
                <div id="reasons-list">
                    {pauseReasons.map((reason) => (
                        <div key={reason.Id}>
                            <p>{reason.name}</p>
                            <button
                                type="button"
                                onClick={() => {
                                    const validated = validatePriv(2);
                                    if (!validated) {
                                        return;
                                    }
                                    removePauseReason(reason.Id);
                                }}
                            >
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
                        placeholder="first-last"
                        onChange={(e) => setUserInput(e.target.value)}
                    />
                    <input
                        id="user-pass-input"
                        type="text"
                        placeholder="Password (Optional)"
                        onChange={(e) => {
                            setPassword(e.target.value);
                        }}
                    />
                    <select
                        onChange={(e) => setPrivLevelSelect(Number(e.target.value))}
                        name="priv-level-select"
                        id="priv-select"
                    >
                        <option value="3">3</option>
                        <option value="2">2</option>
                        <option value="1">1</option>
                    </select>
                    <button type="button" id="add-user-button" onClick={saveUser}>
                        Add User
                    </button>
                </div>
                <div id="users-list">
                    {users.slice(startIndex, endIndex).map((user) => (
                        <div key={user.Id}>
                            <p>{user.name}</p>
                            <button type="button" onClick={() => removeUser(user.Id, user.name)}>
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
