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

/** Every event a tap on a touch panel produces, in the order they arrive. */
const GESTURE_EVENTS = [
    "pointerdown",
    "pointerup",
    "pointercancel",
    "mousedown",
    "mouseup",
    "click",
    "dblclick",
    "contextmenu",
    "touchstart",
    "touchend",
    "touchcancel",
];

// How long after the waking touch the screensaver keeps swallowing input. A
// tap's pointerdown-to-click is well under 300ms, and the window is extended by
// each event it eats, so a slow press is covered too...
const WAKE_TAIL_MS = 400;
// ...and capped from the first event of the gesture, so a stuck or repeating
// input can never leave the panel permanently deaf.
const WAKE_MAX_MS = 3000;

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
    // Still on screen - invisible - for the rest of the gesture that woke it.
    // See the swallow handler below: unmounting on the first event of that
    // gesture is what let the wake-up tap through to the button underneath.
    const [dismissing, setDismissing] = useState(false);
    const [minutes, setMinutes] = useState(readScreensaverMinutes);
    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const displayTimer = useSyncedTimer();
    const timerRef = useRef<number | null>(null);
    // null until the window type is known - never arm on a guess.
    const [isAnalytics, setIsAnalytics] = useState<boolean | null>(null);

    // Read by the window-level swallow handler, which is registered once and
    // must see the CURRENT state rather than the one captured at mount.
    const asleepRef = useRef(false);
    asleepRef.current = asleep;
    const swallowUntil = useRef(0);
    const wokeAt = useRef(0);
    const dismissTimer = useRef<number | null>(null);
    const armRef = useRef<() => void>(() => {});

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

    // --- The wake-up tap belongs to the screensaver, and to nothing else ----
    //
    // Randy, 2026-09-11: touching the panel to clear the screensaver also
    // pressed whatever button was behind it - which on this page means Start,
    // Pause, End or Submit on a live build.
    //
    // Dismissing on the overlay's own onPointerDown could never have prevented
    // that. One tap is a whole burst of events (pointerdown, mousedown,
    // pointerup, mouseup, click); the overlay was unmounted on the first of
    // them, and the rest hit-test against whatever the finger is now over.
    // Calling preventDefault on a pointerdown does not suppress the click that
    // follows either - the Pointer Events spec exempts click specifically.
    //
    // So the whole gesture is swallowed instead. These listeners sit on the
    // window in the CAPTURE phase, which runs before React's root handler and
    // before any document-level listener, and every event inside the window is
    // stopped dead there. The overlay also stays mounted (transparent) until
    // that window closes, so an event that somehow escaped would still
    // hit-test against the screensaver rather than a button.
    useEffect(() => {
        const holdDismissed = () => {
            if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
            dismissTimer.current = window.setTimeout(() => {
                dismissTimer.current = null;
                setDismissing(false);
            }, Math.max(0, swallowUntil.current - Date.now()));
        };

        const swallow = (e: Event) => {
            const now = Date.now();
            if (asleepRef.current) {
                // First event of the waking gesture.
                wokeAt.current = now;
                setAsleep(false);
                setDismissing(true);
                // The idle countdown is normally rearmed by the `wake` listener
                // below, which this handler has just stopped from running.
                armRef.current();
            } else if (now >= swallowUntil.current) {
                // Ordinary interaction with the app. Left completely alone: no
                // preventDefault, no stopPropagation, nothing.
                return;
            }
            swallowUntil.current = Math.min(now + WAKE_TAIL_MS, wokeAt.current + WAKE_MAX_MS);
            holdDismissed();
            if (e.cancelable) e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        };

        GESTURE_EVENTS.forEach((type) =>
            window.addEventListener(type, swallow, { capture: true, passive: false })
        );
        return () => {
            GESTURE_EVENTS.forEach((type) =>
                window.removeEventListener(type, swallow, { capture: true })
            );
            if (dismissTimer.current) window.clearTimeout(dismissTimer.current);
        };
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
        armRef.current = arm;

        // Pointer events are handled by the swallow listener above while the
        // screensaver is showing; these keep the idle countdown honest during
        // normal use, and wake on the inputs the swallow handler leaves alone.
        // A key press still reaches whatever is focused: a scanner must not
        // lose its first character to the screensaver.
        const wake = () => {
            setAsleep((was) => (was ? false : was));
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

    if (!asleep && !dismissing) return null;

    // Asleep wins over dismissing. They cannot overlap at any timeout the
    // Settings page can produce (a minute against 400ms), but if they ever did
    // the panel would be showing a transparent overlay while asleep - awake to
    // look at, deaf to touch.
    const fadingOut = dismissing && !asleep;

    return (
        <div
            className={fadingOut ? "screensaver dismissing" : "screensaver"}
            aria-hidden={fadingOut}
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
