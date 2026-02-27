export interface HarnProgress {
    kitId: number;
    harns: {
        harnNumber: string;
        buildNumber: number;
        built: number;
    }[];
}
