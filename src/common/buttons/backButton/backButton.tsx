import { useLocation, useNavigate } from "react-router-dom";
import "./backButton.css";

/**
 * Back up one level.
 *
 * Randy, 2026-09-11: the harness list had no way out. Picking the wrong job
 * left the operator on a screen whose only controls page through part numbers,
 * so the way back to the job list was to restart the app.
 *
 * The parent is looked up from the route rather than taken from browser
 * history. History would send them wherever they happened to come from, which
 * after a trip through Settings or the pause screen is not "up a level" at all.
 * This is the fixed shape of the app: builders -> jobs -> harnesses -> timer.
 *
 * Navigation ONLY. It never touches the clock, the roster or the build, so it
 * is safe on a screen reached mid-build. A route with no parent renders
 * nothing, so this can be dropped on any page without checking first.
 */
const PARENT: Record<string, { to: string; label: string }> = {
    "/choose-harn": { to: "/choose-kit", label: "Jobs" },
    "/choose-kit": { to: "/", label: "Builders" },
};

function BackButton() {
    const nav = useNavigate();
    const { pathname } = useLocation();
    const parent = PARENT[pathname];
    if (!parent) return null;

    return (
        <div className="back-row">
            <button
                type="button"
                className="back-button"
                id="back-button"
                onClick={() => nav(parent.to)}
            >
                <span className="back-chevron" aria-hidden="true">
                    &#8249;
                </span>
                {parent.label}
            </button>
        </div>
    );
}

export default BackButton;
