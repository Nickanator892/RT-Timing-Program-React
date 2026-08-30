import { useEffect, useState } from "react";

/**
 * Burn-in protection for a display that must stay readable.
 *
 * The analytics screen shows the same layout for entire shifts, so static
 * bright elements (the timer, the axis lines, the logo) etch into the panel.
 * A screensaver is wrong here - the whole point of that screen is being read
 * from across the shop - so instead the entire view creeps a few pixels every
 * few minutes, which is what commercial signage does.
 *
 * Implemented as a transform, deliberately: transforms do not trigger layout,
 * so the chart never re-renders and nothing reflows. The slight scale-down
 * gives the shift somewhere to go, so no edge content is ever clipped.
 */

const OFFSETS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
];

export interface PixelShiftOptions {
    /** How far to travel from centre, in pixels, on each axis. */
    amplitudePx?: number;
    /** How often to move. */
    intervalMs?: number;
    /** Shrink factor that reserves room for the shift so nothing is clipped. */
    scale?: number;
}

export function usePixelShift({
    amplitudePx = 12,
    intervalMs = 4 * 60_000,
    scale = 0.985,
}: PixelShiftOptions = {}) {
    const [step, setStep] = useState(0);

    useEffect(() => {
        const id = window.setInterval(() => setStep((s) => (s + 1) % OFFSETS.length), intervalMs);
        return () => window.clearInterval(id);
    }, [intervalMs]);

    const [x, y] = OFFSETS[step];
    return {
        transform: `translate(${x * amplitudePx}px, ${y * amplitudePx}px) scale(${scale})`,
        // Long, eased move so it is never perceived as the screen "jumping".
        transition: "transform 6s ease-in-out",
        willChange: "transform",
    } as const;
}

export default usePixelShift;
