import { useEffect } from "react";
import { useSharedState } from "./useSharedState";

export interface BuildKit {
    REV: number;
    harnesses: {
        partNum: string;
        buildNumber: number;
        buildTargetTime: {
            seconds: number;
            formattedTime: string;
        };
    }[];
}

export interface SQLBuildKitReturn {
    kitName: string;
    harnNumber: string;
    REV: number;
    qty: number;
    daysToComplete: number;
    targetSetupTime: number; // Minutes
    targetBuildTime: number; // Minutes
    targetBraidTime: number; // Minutes
}

export function useBuildKit() {
    const [buildKit, setBuildKit] = useSharedState<BuildKit | null>("selectedBuildKit", null);
    const [buildKits, setBuildKits] = useSharedState<BuildKit[] | null>("AllBuildKits", null);

    async function fetchKit(rev: number): Promise<BuildKit | undefined> {
        const result = await execQuery(
            `SELECT CASE WHEN LAG(PHK.PHKITNAME) OVER (ORDER BY BKL.BLDORD ASC, PH.INBUILD ASC) = PHK.PHKITNAME THEN '' ELSE PHK.PHKITNAME END AS 'Kit Name', PH.HARNPN, BKL.REV, (PH.QTY * PH.ALTQTY) AS 'Qty To Build', printf('%.2f',PH.SCHTIMEDAYS) AS 'Days To Complete PN', printf('%.2f',PH.SPLSETUPTIME * PH.QTY * PH.ALTQTY) AS 'Target Setup Time (Minutes)', printf('%.2f',PH.SPLBUILDTIME) AS 'Target Build Time (Minutes)', printf('%.2f',PH.BRDTIME) AS 'Target Braid Time (Minutes)' FROM BUILDKITLIST BKL LEFT JOIN PROJHARN PH ON PH.KITID = BKL.PHKID AND PH.RID = BKL.REV LEFT JOIN PERMHARNKITS PHK ON PHK.PHKID = BKL.PHKID WHERE BKL.REV=(?) ORDER BY BKL.BLDORD ASC, PH.INBUILD ASC;`,
            [rev]
        );

        if (!Array.isArray(result) || result.length === 0) return undefined;

        const harnesses = result.map((row) => {
            const totalSeconds = Math.floor(row.targetBuildTime * 60);
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const formattedTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
                2,
                "0"
            )}:${String(seconds).padStart(2, "0")}`;
            return {
                partNum: row.harnNumber,
                buildNumber: row.qty,
                buildTargetTime: {
                    seconds: totalSeconds,
                    formattedTime,
                },
            };
        });

        const formattedKit: BuildKit = { REV: rev, harnesses };
        setBuildKit(formattedKit);
        return formattedKit; // ← Component receives this directly, no stale closure issue
    }
    const execQuery = async (
        requestedQuery: string,
        params: unknown[] = []
    ): Promise<SQLBuildKitReturn[] | undefined> => {
        try {
            const response = await fetch("http://localhost:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: requestedQuery, params }),
            });
            const data = await response.json();

            if (data.success === false) return;

            // Remap SQL column names to interface keys
            const remapped: SQLBuildKitReturn[] = data.result.map((row: any) => ({
                kitName: row["Kit Name"],
                harnNumber: row["HARNPN"],
                REV: row["REV"],
                qty: row["Qty To Build"],
                daysToComplete: parseFloat(row["Days To Complete PN"]),
                targetSetupTime: parseFloat(row["Target Setup Time (Minutes)"]),
                targetBuildTime: parseFloat(row["Target Build Time (Minutes)"]),
                targetBraidTime: parseFloat(row["Target Braid Time (Minutes)"]),
            }));

            return remapped;
        } catch (err: any) {
            console.log(err);
        }
    };

    async function fetchKits() {
        const result: SQLBuildKitReturn[] | undefined = (await execQuery(
            `SELECT CASE WHEN LAG(PHK.PHKITNAME) OVER (ORDER BY BKL.BLDORD ASC, PH.INBUILD ASC) = PHK.PHKITNAME THEN '' ELSE PHK.PHKITNAME END AS 'Kit Name', PH.HARNPN, BKL.REV, (PH.QTY * PH.ALTQTY) AS 'Qty To Build', printf('%.2f',PH.SCHTIMEDAYS) AS 'Days To Complete PN', printf('%.2f',PH.SPLSETUPTIME * PH.QTY * PH.ALTQTY) AS 'Target Setup Time (Minutes)', printf('%.2f',PH.SPLBUILDTIME) AS 'Target Build Time (Minutes)', printf('%.2f',PH.BRDTIME) AS 'Target Braid Time (Minutes)' FROM BUILDKITLIST BKL LEFT JOIN PROJHARN PH ON PH.KITID = BKL.PHKID AND PH.RID = BKL.REV LEFT JOIN PERMHARNKITS PHK ON PHK.PHKID = BKL.PHKID ORDER BY BKL.REV DESC`,
            []
        )) as SQLBuildKitReturn[] | undefined;
        if (Array.isArray(result) && result.length > 0) {
            const kitMap = new Map<number, BuildKit>();

            result.forEach((row) => {
                const totalSeconds = Math.floor(row.targetBuildTime * 60);
                const hours = Math.floor(totalSeconds / 3600);
                const minutes = Math.floor((totalSeconds % 3600) / 60);
                const seconds = totalSeconds % 60;
                const formattedTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(
                    2,
                    "0"
                )}:${String(seconds).padStart(2, "0")}`;

                const harness = {
                    partNum: row.harnNumber,
                    buildNumber: row.qty,
                    buildTargetTime: {
                        seconds: row.targetBuildTime * 60,
                        formattedTime: formattedTime,
                    },
                };

                if (kitMap.has(row.REV)) {
                    // REV already exists, just push the new harness into it
                    kitMap.get(row.REV)!.harnesses.push(harness);
                } else {
                    // First time seeing this REV, create a new entry
                    kitMap.set(row.REV, {
                        REV: row.REV,
                        harnesses: [harness],
                    });
                }
            });

            setBuildKits(Array.from(kitMap.values()));
        }
    }

    useEffect(() => {
        fetchKits();
    }, []);

    return {
        buildKit,
        buildKits,
        fetchKit,
        fetchKits,
        setBuildKit,
    };
}
