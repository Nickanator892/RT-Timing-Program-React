import { useEffect, useRef, useState } from "react";
import { useSharedState } from "./useSharedState";

export function useSyncedTimer() {
    const [displayTimer] = useSharedState<string>("displayTimer", "00:00:00");
    const [elapsedTime] = useSharedState<number>("elapsedTime", 0);
    const [isRunning] = useSharedState<boolean>("isRunning", false);
    const [localDisplay, setLocalDisplay] = useState(displayTimer);
    const rafRef = useRef<number | null>(null);
    const baseTimeRef = useRef<number>(0);
    const baseElapsedRef = useRef<number>(0);

    function formatTime(ms: number): string {
        const totalSeconds = Math.floor(ms / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
            seconds
        ).padStart(2, "0")}`;
    }

    // Sync base time whenever main process broadcasts
    useEffect(() => {
        baseTimeRef.current = Date.now();
        baseElapsedRef.current = elapsedTime;
        setLocalDisplay(displayTimer);
    }, [displayTimer, elapsedTime]);

    // Run local RAF loop when running
    useEffect(() => {
        if (!isRunning) {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
            setLocalDisplay(displayTimer); // 👈 sync display when stopped
            return;
        }

        if (elapsedTime === 0 && displayTimer === "00:00:00") return;

        // Immediately set the correct time before starting RAF
        baseTimeRef.current = Date.now();
        baseElapsedRef.current = elapsedTime;
        setLocalDisplay(displayTimer); // 👈 set correct time instantly

        function tick() {
            const now = Date.now();
            const localElapsed = baseElapsedRef.current + (now - baseTimeRef.current);
            setLocalDisplay(formatTime(localElapsed));
            rafRef.current = requestAnimationFrame(tick);
        }

        rafRef.current = requestAnimationFrame(tick);
        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [isRunning, elapsedTime]);

    return localDisplay;
}
