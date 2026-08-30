import "./screensaver.css";
import { useEffect, useRef, useState } from "react";
import { useSharedState } from "../../hooks/useSharedState";
import { useSyncedTimer } from "../../hooks/useSyncedTimer";

/**
 * Idle screen for the shop-floor panel.
 *
 * The station sits on one screen all shift, so a static image burns into the
 * panel. After a period with no touch this dims the display and drifts a small
 * status block around it. It deliberately keeps showing the part number and the
 * live elapsed time: an operator walking past should still be able to read the
 * state of the build without waking it. Any touch or key dismisses it.
 *
 * Timeout is per-station (localStorage), set on the Settings page. 0 = off.
 */

export const SCREENSAVER_KEY = "screensaverMinutes";
export const DEFAULT_SCREENSAVER_MINUTES = 10;

export function readScreensaverMinutes(): number {
    const raw = Number(localStorage.getItem(SCREENSAVER_KEY));
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_SCREENSAVER_MINUTES;
    return raw;
}

function Screensaver() {
    const [asleep, setAsleep] = useState(false);
    const [minutes, setMinutes] = useState(readScreensaverMinutes);
    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const displayTimer = useSyncedTimer();
    const timerRef = useRef<number | null>(null);

    // The Settings page writes the new value to localStorage; pick it up
    // without needing an app restart.
    useEffect(() => {
        const poll = window.setInterval(() => setMinutes(readScreensaverMinutes()), 5000);
        return () => window.clearInterval(poll);
    }, []);

    useEffect(() => {
        if (minutes <= 0) {
            setAsleep(false);
            return;
        }

        const arm = () => {
            if (timerRef.current) window.clearTimeout(timerRef.current);
            timerRef.current = window.setTimeout(() => setAsleep(true), minutes * 60_000);
        };

        const wake = () => {
            setAsleep((was) => {
                if (was) return false;
                return was;
            });
            arm();
        };

        const events = ["pointerdown", "keydown", "wheel", "touchstart"];
        events.forEach((e) => document.addEventListener(e, wake, { passive: true }));
        arm();
        return () => {
            events.forEach((e) => document.removeEventListener(e, wake));
            if (timerRef.current) window.clearTimeout(timerRef.current);
        };
    }, [minutes]);

    if (!asleep) return null;

    return (
        <div
            className="screensaver"
            // The dismissing tap must not also press whatever is underneath.
            onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setAsleep(false);
            }}
        >
            <div className="screensaver-drift">
                <div className="screensaver-logo">
                    <span id="RT-part-one">RT </span>
                    <span id="RT-part-two">Technologies</span>
                </div>
                {selectedHarn ? (
                    <>
                        <div className="screensaver-pn">{selectedHarn}</div>
                        <div className={`screensaver-timer ${isRunning ? "running" : ""}`}>
                            {displayTimer}
                        </div>
                        <div className="screensaver-state">{isRunning ? "RUNNING" : "PAUSED"}</div>
                    </>
                ) : (
                    <div className="screensaver-idle">Touch to begin</div>
                )}
            </div>
        </div>
    );
}

export default Screensaver;
