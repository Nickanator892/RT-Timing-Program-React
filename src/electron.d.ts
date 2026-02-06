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

declare global {
    interface Window {
        electron: {
            readSettings: () => Promise<Settings>;
            writeSettings: (settings: Settings) => Promise<{ success: boolean; error?: string }>;
        };
    }
}

export {};
