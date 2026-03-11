import { useState } from "react";
import useSettings from "../../hooks/useSettings";
import "./settingsPage.css";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import type { User } from "../../assets/types/UserType";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";
import RTLogo from "../../components/RTLogo/RTLogo";
import { UserRoundCheck, UserRoundX, ListCheck, ListX, UsersRound } from "lucide-react";
import { useSharedState } from "../../hooks/useSharedState";

interface settingsPageProps {
    selectedUser: User | undefined;
}

//FIX PRIV VALIDATION ISSUE

function SettingsPage({ selectedUser }: settingsPageProps) {
    const {
        users,
        allPauseReasons,
        allUsers,
        loading,
        addPauseReason,
        reActivatePauseReason,
        deActivatePauseReason,
        addUser,
        deActivateUser,
        activateUser,
    } = useSettings();
    const [inputValue, setInputValue] = useState("");
    const [userInput, setUserInput] = useState("");
    const [err, setErr] = useState("");
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [userToDelete, setUserToDelete] = useState<{ id: number } | null>(null);
    const [currentPage, setCurrentPage] = useState(0);
    const [privLevelSelect, setPrivLevelSelect] = useState<number>(3);
    const [password, setPassword] = useState<string>("");
    const [secondaryBuilders, setSecondaryBuilders] = useSharedState<{Id: Number, name: string}[]>("secondaryBuilders", [])
    const itemsPerPage = 4;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = allUsers.length > endIndex;
    const hasPreviousPage = currentPage > 0;

    console.log(allPauseReasons);

    if (loading) return <p>Loading...</p>;

    console.log(allUsers);

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
                    setTimeout(() => {
                        setErr("");
                    }, 2000);
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

    function removeUser(id: number) {
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
        setUserToDelete({ id: id });
        setShowDeleteModal(true);
    }

    function confirmDelete() {
        if (userToDelete !== null) {
            deActivateUser(userToDelete.id);
            setShowDeleteModal(false);
            setUserToDelete(null);
        }
    }

    function reActivateUser(id: number) {
        if (selectedUser) {
            const validated = validatePriv(2);
            if (!validated) {
                return;
            }
        }
        activateUser(id);
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
                        <h3>Confirm Deactivation</h3>
                        <p>Are you sure you want to deactivate this user?</p>
                        <div className="modal-buttons">
                            <button onClick={confirmDelete}>Yes, Deactivate</button>
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
                    {allPauseReasons.map((reason) => (
                        <div key={reason.Id}>
                            <div className="reason-object">
                                <p>{reason.name}</p>
                                <p id="reason-status">
                                    {reason.active == 1 ? <ListCheck /> : <ListX />}
                                </p>
                            </div>
                            {reason.active == 1 ? (
                                <button
                                    className="pause-reason-buttons"
                                    type="button"
                                    onClick={() => {
                                        const validated = validatePriv(2);
                                        if (!validated) return;
                                        deActivatePauseReason(reason.Id);
                                    }}
                                >
                                    Deactivate Reason
                                </button>
                            ) : (
                                <button
                                    className="pause-reason-buttons"
                                    type="button"
                                    onClick={() => {
                                        const validated = validatePriv(2);
                                        if (!validated) return;
                                        reActivatePauseReason(reason.Id);
                                    }}
                                >
                                    Activate Reason
                                </button>
                            )}
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
                        {allUsers.slice(startIndex, endIndex).map((user) => (
                            <div key={user.Id}>
                                <div className="account-object">
                                    <p className="user-name">
                                        {user.name}{" "}
                                        {user.active == 1 ? (
                                            <UserRoundCheck className="account-status" />
                                        ) : (
                                            <UserRoundX className="account-status" />
                                        )}
                                    </p>
                                    <p id="account-status"></p>
                                </div>
                                {user.active == 1 ? (
                <div>
                    {selectedUser?.Id != user.Id ? (
                        <>  {/* fragment to wrap multiple elements */}
                            <button
                                type="button"
                                className="user-control-button-active"
                                onClick={() => removeUser(user.Id)}
                            >
                                Deactivate User
                            </button>
                            {!secondaryBuilders.some((u) => u.Id === user.Id) ? (
                                <button
                                    type="button"
                                    className="user-control-button-active"
                                    onClick={() => setSecondaryBuilders((prev) => [...prev, {Id: user.Id, name: user.name}])}
                                >
                                    Set Secondary
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="user-control-button-active"
                                    onClick={() => setSecondaryBuilders((prev) => prev.filter((u) => u.Id != user.Id))}
                                >
                                    Remove Secondary
                                </button>
                            )}
                        </>
                    ) : null}  {/* missing else branch */}
                </div>
            ) : (
                <button
                    type="button"
                    className="user-control-button"
                    onClick={() => reActivateUser(user.Id)}
                >
                    Activate User
                </button>
            )}
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
            <RTLogo />{" "}
        </div>
    );
}

export default SettingsPage;
