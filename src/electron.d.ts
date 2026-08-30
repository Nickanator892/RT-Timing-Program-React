interface PauseReason {
    Id: string;
    name: string;
}

interface User {
    Id: number;
    name: string;
}

interface Settings {
    pauseReasons: PauseReason[];
    users: User[];
}

/** A build this station left open, found by the boot-time recovery scan. */
export interface RecoveryCandidate {
    status: "RECOVERABLE" | "STALE";
    segmentId: number;
    buildId: number;
    startTime: string;
    buildStartTime: string;
    heartbeatAt: string | null;
    heartbeatState: "RUN" | "PAUSE" | null;
    segmentAccumSeconds: number;
    buildAccumSeconds: number;
    numberOfBuilders: number;
    harnNumber: string;
    REV: number;
    builderId: number | null;
    builderName: string | null;
    timeTypeId: number;
    hoursSinceHeartbeat: number;
    stationId: string;
    dbNow: string;
}

declare global {
    interface Window {
        electron: {
            readSettings: () => Promise<any>;
            writeSettings: (settings: any) => Promise<{ success: boolean; error?: string }>;
            getSharedData: () => Promise<any>;
            getWindowType: () => Promise<string>;
            updateSharedData: (data: any) => void;
            addSession: (sessionData: any) => void;
            onSharedDataChanged: (callback: (data: any) => void) => () => void;
            openAnalyticsWindow: () => void;
            onNavigateTo?: (callback: (route: string) => void) => () => void;
            timerStart: () => void;
            timerPause: () => void;
            timerReset: () => void;
            timerSegment: (info: { segmentId: number | null; segmentAccumSeconds?: number }) => void;
            getRecovery: () => Promise<RecoveryCandidate | null>;
            getSegmentSeconds: () => Promise<number>;
            restoreTimer: (info: {
                elapsedMs: number;
                segmentId: number;
                segmentAccumSeconds?: number;
            }) => Promise<{ ok: boolean }>;
            dismissRecovery: () => void;
            quitApp: () => void;
            runUpdater: () => Promise<void>;
        };
    }
}
