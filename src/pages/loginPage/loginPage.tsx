import "./loginPage.css";
import type React from "react";
import useSettings from "../../hooks/useSettings";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import RTLogo from "../../components/RTLogo/RTLogo";

interface User {
    Id: number;
    name: string;
    password?: string;
    privLevel?: number;
}

interface loginProps {
    user: User | undefined;
    setUser: React.Dispatch<React.SetStateAction<User | undefined>>;
}

function LoginPage({ setUser }: loginProps) {
    const { users } = useSettings();
    const [password, setPassword] = useState<string>();
    const [disablePassword, setDisablePassword] = useState<boolean>(true);
    const [localSelectedUser, setLocalSelectedUser] = useState<User>();
    const [err, setErr] = useState<string | undefined>();
    // Set at boot by the main process when this station left a build open.
    const [recovery, setRecovery] = useState<any>(null);
    const nav = useNavigate();

    useEffect(() => {
        window.electron.getRecovery().then(setRecovery).catch(() => setRecovery(null));
    }, []);

    /** An interrupted build needs a logged-in builder before anything is
     *  written, so recovery is offered on the way through login. */
    function afterLogin() {
        nav(recovery ? "/recover" : "/choose-kit");
    }

    const [currentPage, setCurrentPage] = useState(0);
    const itemsPerPage = 3;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = users.length > endIndex;
    const hasPreviousPage = currentPage > 0;

    function populateUserList() {
        return users.slice(startIndex, endIndex).map((user) => (
            <div key={user.Id} className="user-list-object">
                <p className="user-name-p">{user.name}</p>
                <button type="button" id="user-list-button" onClick={() => selectUser(user.Id)}>
                    Login
                </button>
            </div>
        ));
    }

    function selectPasswordProtected() {
        if (password == localSelectedUser?.password) {
            setUser(localSelectedUser);
            setTimeout(() => {
                afterLogin();
            }, 500);
        } else {
            setErr("Incorrect password");
            setTimeout(() => {
                setErr("");
            }, 2000);
        }
    }

    function selectUser(Id: number) {
        const found = users.find((user) => user.Id === Id);
        if (!found) return;

        setLocalSelectedUser(found);

        if (found.password) {
            setDisablePassword(false);
            return;
        }

        setUser(found);
        setTimeout(() => {
            nav("/choose-kit");
        }, 500);
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
        <div className="login-page">
            <h2 className="login-header">Select Builder</h2>
            {recovery && (
                <div className="login-recovery-banner">
                    Unfinished build found: <strong>{recovery.harnNumber}</strong>
                    {recovery.builderName ? ` - started by ${recovery.builderName}` : ""}
                    {recovery.heartbeatAt ? `, last active ${recovery.heartbeatAt}` : ""}. Log in to
                    restore it.
                </div>
            )}
            <RTLogo />
            <div id="users-list">{populateUserList()}</div>
            {!disablePassword && (
                <div className="password-entry">
                    <input
                        type="password"
                        name="pwentry"
                        id="pw-entry"
                        placeholder="Password"
                        onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                        style={{ fontSize: "15px", maxWidth: "6em", maxHeight: "2em" }}
                        type="button"
                        id="pw-login-button"
                        onClick={selectPasswordProtected}
                    >
                        Login {localSelectedUser?.name.slice(0, 6)}...
                    </button>
                </div>
            )}
            <p className="error-p">{err}</p>
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

export default LoginPage;
