interface PauseReason {
    Id: string;
    name: string;
}

interface Settings {
    pauseReasons: PauseReason[];
}

declare global {
    interface Window {
        electron: {
            readSettings: () => Promise<Settings>;
            writeSettings: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
        }
    }
}

export {};