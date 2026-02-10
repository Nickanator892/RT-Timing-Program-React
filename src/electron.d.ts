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


export {};

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
        };
    }
}