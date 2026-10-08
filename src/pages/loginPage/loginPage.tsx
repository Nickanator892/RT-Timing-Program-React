import "./loginPage.css";
import type React from "react";
import useSettings from "../../hooks/useSettings";
import { useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import RTLogo from "../../components/RTLogo/RTLogo";
import { recentOperatorsFirst, rememberOperator } from "../../assets/operatorOrder";

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

/** How often this page asks the backend whether the database answers. */
const DB_CHECK_MS = 10_000;

/** Short enough to read across the bench. Cut from the middle: a module
 *  error names the file first and the reason last ("...better_sqlite3.node:
 *  cannot open shared object file"), and both halves matter. */
function shortError(text: string): string {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 200 ? line.slice(0, 110) + " ... " + line.slice(-80) : line;
}

function LoginPage({ setUser }: loginProps) {
    const { users, loading, loadError, reload } = useSettings();
    // Why the database cannot be used right now, or null. On 2026-10-07 the
    // panel ran 20 minutes on a better-sqlite3 module that would not load:
    // every query failed, this page showed an empty builder list and nothing
    // else, and it was rebooted twice. /api/db-status's test query fails in
    // exactly that state (readable:false); ready:false is the file itself gone,
    // e.g. the share dropped after start. RtMcs write trouble is the timer
    // page's to report, not this one's.
    const [dbProblem, setDbProblem] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const check = async () => {
            let problem: string | null = null;
            try {
                const data = await (await fetch("http://localhost:5000/api/db-status")).json();
                if (data?.readable === false || data?.ready === false)
                    problem = String(data.writeError || data.error || "it did not answer a test query");
            } catch (err) {
                problem = `the timer's own server did not answer (${err instanceof Error ? err.message : String(err)})`;
            }
            if (!cancelled) setDbProblem(problem);
        };

        check();
        // Every query starts a fresh worker that loads the module again, so a
        // repair takes effect without a restart - and this warning clears itself.
        const id = setInterval(check, DB_CHECK_MS);
        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, []);

    // The first load gives up after 10 tries. Once the database answers
    // again, try once every DB_CHECK_MS until the list arrives.
    useEffect(() => {
        if (dbProblem !== null || !loadError || loading) return;
        const id = setTimeout(reload, DB_CHECK_MS);
        return () => clearTimeout(id);
    }, [dbProblem, loadError, loading, reload]);

    const dbWarning = dbProblem ?? loadError;
    const [password, setPassword] = useState<string>();
    const [disablePassword, setDisablePassword] = useState<boolean>(true);
    const [localSelectedUser, setLocalSelectedUser] = useState<User>();
    const [err, setErr] = useState<string | undefined>();
    // Set at boot by the main process when this station left a build open.
    const [recovery, setRecovery] = useState<any>(null);
    const nav = useNavigate();

    useEffect(() => {
        let cancelled = false;
        const poll = () =>
            window.electron
                .getRecovery()
                .then((r) => {
                    if (!cancelled) setRecovery(r);
                    return r;
                })
                .catch(() => null);

        poll();
        // The boot scan can come back empty because the file share is slower to
        // return than the Pi after a power cut; main keeps scanning for a couple
        // of minutes. Without this the operator would have logged in during that
        // window and never been offered the build. Reading a variable over IPC.
        const id = setInterval(async () => {
            if ((await poll()) || cancelled) clearInterval(id);
        }, 10000);

        return () => {
            cancelled = true;
            clearInterval(id);
        };
    }, []);

    /** An interrupted build needs a logged-in builder before anything is
     *  written, so recovery runs on the way through login. EVERY login path has
     *  to come through here: the password-less path used to jump straight to
     *  /choose-kit, which is how a builder walked past his own open build,
     *  started a new one instead and hit a write error (2026-08-31). */
    function afterLogin() {
        nav(recovery ? "/recover" : "/choose-kit");
    }

    const [currentPage, setCurrentPage] = useState(0);
    const itemsPerPage = 3;
    const startIndex = currentPage * itemsPerPage;
    const endIndex = startIndex + itemsPerPage;
    const hasNextPage = users.length > endIndex;
    const hasPreviousPage = currentPage > 0;
    // Three at a time, so whoever built here last must not be on page two
    // (Randy, 2026-09-11: ashley was, on the panel she had worked all morning).
    const ordered = recentOperatorsFirst(users);

    function populateUserList() {
        return ordered.slice(startIndex, endIndex).map((user) => (
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
            rememberOperator(localSelectedUser?.Id);
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

        rememberOperator(found.Id);
        setUser(found);
        setTimeout(() => {
            afterLogin();
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
            {dbWarning && (
                <div className="login-db-warning">
                    The database is not answering - the builder list cannot load. Leave the
                    timer running and get someone to look at it (the error: {shortError(dbWarning)}).
                    <div className="login-db-warning-note">
                        This clears by itself once the database answers again.
                    </div>
                </div>
            )}
            {recovery && (
                <div className="login-recovery-banner">
                    Unfinished build found: <strong>{recovery.harnNumber}</strong>
                    {recovery.builderName ? ` - started by ${recovery.builderName}` : ""}
                    {recovery.heartbeatAt ? `, last active ${recovery.heartbeatAt}` : ""}.{" "}
                    {recovery.builderName
                        ? `${recovery.builderName} logs in and it opens straight up, paused.`
                        : "Log in to restore it."}
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
