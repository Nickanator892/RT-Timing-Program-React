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

    /**
     * @param phkid Restrict to ONE kit inside the rev. A rev can carry several
     *  scheduled jobs - rev 5450 holds both the Schellvac Variable (9 harnesses)
     *  and Constant (15) kits - and loading the rev whole drops all 24 into one
     *  undifferentiated list. Null keeps the old whole-rev behaviour, which is
     *  what crash recovery needs: it only knows the rev.
     */
    async function fetchKit(rev: number, phkid: number | null = null): Promise<BuildKit | undefined> {
        const result = await execQuery(
            `SELECT CASE WHEN LAG(PHK.PHKITNAME) OVER (ORDER BY BKL.BLDORD ASC, PH.INBUILD ASC) = PHK.PHKITNAME THEN '' ELSE PHK.PHKITNAME END AS 'Kit Name', PH.HARNPN, BKL.REV, (PH.QTY * PH.ALTQTY) AS 'Qty To Build', printf('%.2f',PH.SCHTIMEDAYS) AS 'Days To Complete PN', printf('%.2f',PH.SPLSETUPTIME * PH.QTY * PH.ALTQTY) AS 'Target Setup Time (Minutes)', printf('%.2f',PH.SPLBUILDTIME) AS 'Target Build Time (Minutes)', printf('%.2f',PH.BRDTIME) AS 'Target Braid Time (Minutes)' FROM BUILDKITLIST BKL LEFT JOIN PROJHARN PH ON PH.KITID = BKL.PHKID AND PH.RID = BKL.REV LEFT JOIN PERMHARNKITS PHK ON PHK.PHKID = BKL.PHKID WHERE BKL.REV=(?) AND ((?) IS NULL OR BKL.PHKID = (?)) ORDER BY BKL.BLDORD ASC, PH.INBUILD ASC;`,
            [rev, phkid, phkid]
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

    // fetchKits() lived here: it read EVERY kit of EVERY rev in the database and
    // ran from a useEffect on every mount of this hook - so on the timer page,
    // the harness page and the recovery page, none of which ever looked at the
    // result. Its only consumer was the old rev-number picker, replaced by the
    // job list, which reads the schedule instead. Removed rather than left to
    // scan BUILDKITLIST x PROJHARN across the network share on every screen.

    return {
        buildKit,
        fetchKit,
        setBuildKit,
    };
}
