import { useEffect, useState } from "react";
import "./windowControl.css";

/**
 * The way out of the full-screen timer.
 *
 * Randy, 2026-10-07: the panel runs the timer full screen (electron/main.js
 * wantFullScreen), so the title-bar X and the taskbar are gone. This corner
 * control replaces them: leave full screen (title bar and taskbar come back),
 * or close the app through the same "Close RT Timing?" question the X asked
 * (main.js confirmClose, via quitApp). Nothing happens on the first tap - it
 * only opens the menu - and closing still asks, so a glove brushing the corner
 * cannot end anyone's timing.
 *
 * Timer window only: the analytics window keeps its own title bar.
 */
function WindowControl() {
    const [isMain, setIsMain] = useState(false);
    const [fullScreen, setFullScreen] = useState(false);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        let cancelled = false;
        window.electron
            .getWindowType()
            .then((t) => !cancelled && setIsMain(t === "main"))
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);

    useEffect(() => {
        if (!isMain) return;
        let cancelled = false;
        const read = () =>
            window.electron
                .getWindowState()
                .then((s) => !cancelled && setFullScreen(!!s?.fullScreen))
                .catch(() => {});
        read();
        const off = window.electron.onWindowStateChanged?.((s) => setFullScreen(!!s?.fullScreen));
        // The window manager can change it too (a keyboard shortcut, a second
        // monitor); a resize always comes with that, so re-ask then.
        window.addEventListener("resize", read);
        return () => {
            cancelled = true;
            off?.();
            window.removeEventListener("resize", read);
        };
    }, [isMain]);

    if (!isMain) return null;

    return (
        <>
            <button
                type="button"
                className={`window-control-button${open ? " is-open" : ""}`}
                aria-label="Window menu"
                onClick={() => setOpen((v) => !v)}
            >
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
                    <rect x="3" y="5" width="18" height="2.5" rx="1" />
                    <rect x="3" y="10.75" width="18" height="2.5" rx="1" />
                    <rect x="3" y="16.5" width="18" height="2.5" rx="1" />
                </svg>
            </button>
            {open && (
                <>
                    <div className="window-control-backdrop" onClick={() => setOpen(false)} />
                    <div className="window-control-menu" role="menu">
                        <button
                            type="button"
                            role="menuitem"
                            className="window-control-item"
                            onClick={() => {
                                setOpen(false);
                                window.electron.setFullScreen(!fullScreen);
                            }}
                        >
                            {fullScreen ? "Leave full screen" : "Full screen"}
                        </button>
                        <button
                            type="button"
                            role="menuitem"
                            className="window-control-item window-control-close"
                            onClick={() => {
                                setOpen(false);
                                window.electron.quitApp();
                            }}
                        >
                            Close the timer...
                        </button>
                    </div>
                </>
            )}
        </>
    );
}

export default WindowControl;
