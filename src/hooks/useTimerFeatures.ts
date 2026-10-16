import { useEffect, useState } from "react";

/**
 * The 2026-10-16 timer features this panel uses (Randy: paused builds no
 * longer block, shared sessions and packaging sessions, time-edit marks).
 * Each is on only when this station's db-config.json switches it on AND the
 * database has what it needs (server.ts timerFeatures) - the same rule the
 * RT-MCS phone timer applies, so both timers go live together. All off is the
 * panel exactly as it was.
 */
export interface TimerFeatures {
    pausedFree: boolean;
    sharedSessions: boolean;
    timeEdits: boolean;
}

const OFF: TimerFeatures = { pausedFree: false, sharedSessions: false, timeEdits: false };
const REFRESH_MS = 60_000;

let cached: TimerFeatures = OFF;
let fetchedAt = 0;
let inFlight: Promise<TimerFeatures> | null = null;

/** The current answer, asked of the backend at most once a minute. Any
 *  failure reads as all off. */
export function timerFeatures(): Promise<TimerFeatures> {
    if (Date.now() - fetchedAt < REFRESH_MS) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const r = await fetch("http://localhost:5000/api/timer/features");
            const d = await r.json();
            const f = d?.result ?? {};
            cached = { pausedFree: f.pausedFree === true, sharedSessions: f.sharedSessions === true, timeEdits: f.timeEdits === true };
        } catch {
            cached = OFF;
        }
        fetchedAt = Date.now();
        return cached;
    })().finally(() => {
        inFlight = null;
    });
    return inFlight;
}

export function useTimerFeatures(): TimerFeatures {
    const [features, setFeatures] = useState<TimerFeatures>(cached);
    useEffect(() => {
        let alive = true;
        const ask = () =>
            void timerFeatures().then((f) => {
                if (alive) setFeatures((prev) => (sameFeatures(prev, f) ? prev : f));
            });
        ask();
        const id = window.setInterval(ask, REFRESH_MS);
        return () => {
            alive = false;
            window.clearInterval(id);
        };
    }, []);
    return features;
}

function sameFeatures(a: TimerFeatures, b: TimerFeatures): boolean {
    return a.pausedFree === b.pausedFree && a.sharedSessions === b.sharedSessions && a.timeEdits === b.timeEdits;
}
