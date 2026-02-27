import type React from "react";
import useSettings from "../../hooks/pauseReasonHook";
import "./loginPage.css";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

interface User {
    Id: number;
    name: string;
}

interface loginProps {
    user: User | undefined;
    setUser: React.Dispatch<React.SetStateAction<User | undefined>>;
}

function LoginPage({ setUser }: loginProps) {
    const { users } = useSettings();
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

    function selectUser(Id: number) {
        let selectedUser = undefined;
        users.map((user) => {
            if (user.Id == Id) {
                selectedUser = user;
            }
        });
        if (selectedUser != undefined) {
            setUser(selectedUser);
            setTimeout(() => {
                nav("/choose-kit");
            }, 500);
        }
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
