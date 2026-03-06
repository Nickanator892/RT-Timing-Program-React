import type React from "react";
import useSettings from "../../hooks/pauseReasonHook";
import "./loginPage.css";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

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
    const nav = useNavigate();

    const [currentPage, setCurrentPage] = useState(0);
    const itemsPerPage = 5;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = users.length > endIndex;
    const hasPreviousPage = currentPage > 0;

    function populateUserList() {
        return users.slice(startIndex, endIndex).map((user) => (
            <div key={user.Id}>
                <p>{user.name}</p>
                <button type="button" onClick={() => selectUser(user.Id)}>
                    Login
                </button>
            </div>
        ));
    }

    function selectPasswordProtected() {
        if (password == localSelectedUser?.password) {
            setUser(localSelectedUser);
            setTimeout(() => {
                nav("/choose-kit");
            }, 500);
        } else {
            setErr("Incorrect password");
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
        <div>
            <h2 className="login-header">Select Builder</h2>
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
                        Login
                    </button>
                    <p className="error-p">{err}</p>
                </div>
            )}
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
