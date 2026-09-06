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
    const stored = localStorage.getItem(SCREENSAVER_KEY);
    // "Never set" is NOT zero. Number(null) is 0, and 0 means OFF here, so the
    // old one-line read returned 0 for a station that had simply never opened
    // Settings - which is every station. The screensaver has therefore never
    // armed on the Pi (verified 2026-09-06: the key is absent from its
    // localStorage), and DEFAULT_SCREENSAVER_MINUTES only ever applied to
    // garbage or negative values. Absent must fall through to the default; an
    // explicit 0 must still mean off.
    if (stored === null || stored.trim() === "") return DEFAULT_SCREENSAVER_MINUTES;
    const raw = Number(stored);
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
    // null until the window type is known - never arm on a guess.
    const [isAnalytics, setIsAnalytics] = useState<boolean | null>(null);

    // This component is mounted by TimerLayout, which both windows share, so
    // without this gate the analytics screen would black out too - and that
    // screen exists to be read from across the shop (see usePixelShift, which
    // is the burn-in answer there). It has never happened only because the
    // screensaver never armed at all; fixing that read would have blanked the
    // second screen for the first time.
    useEffect(() => {
        let cancelled = false;
        window.electron
            .getWindowType()
            .then((t) => !cancelled && setIsAnalytics(t === "analytics"))
            .catch(() => !cancelled && setIsAnalytics(false));
        return () => {
            cancelled = true;
        };
    }, []);

    // The Settings page writes the new value to localStorage; pick it up
    // without needing an app restart.
    useEffect(() => {
        const poll = window.setInterval(() => setMinutes(readScreensaverMinutes()), 5000);
        return () => window.clearInterval(poll);
    }, []);

    useEffect(() => {
        if (minutes <= 0 || isAnalytics !== false) {
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
    }, [minutes, isAnalytics]);

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
