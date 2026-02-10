import { useEffect, useState, useCallback } from "react";

export function useSharedState<T>(key: string, initialValue: T) {
    const [value, setValue] = useState<T>(initialValue);
    const [isInitialized, setIsInitialized] = useState(false);

    useEffect(() => {
        const loadInitialData = async () => {
            try {
                const sharedData = await window.electron.getSharedData();
                if (sharedData && sharedData[key] !== undefined) {
                    setValue(sharedData[key]);
                }
                setIsInitialized(true);
            } catch (error) {
                console.error("Failed to load shared data:", error);
                setIsInitialized(true);
            }
        };

        loadInitialData();
    }, [key]);

    useEffect(() => {
        const unsubscribe = window.electron.onSharedDataChanged((sharedData: any) => {
            if (sharedData && sharedData[key] !== undefined) {
                setValue(sharedData[key]);
            }
        });

        return unsubscribe;
    }, [key]);

    const updateValue = useCallback((newValue: T | ((prev: T) => T)) => {
        setValue(prev => {
            const updated = typeof newValue === "function" 
                ? (newValue as (prev: T) => T)(prev) 
                : newValue;
            
            window.electron.updateSharedData({ [key]: updated });
            
            return updated;
        });
    }, [key]);

    return [value, updateValue, isInitialized] as const;
}