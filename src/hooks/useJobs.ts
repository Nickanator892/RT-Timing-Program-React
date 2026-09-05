import { useCallback, useEffect, useState } from "react";

/**
 * The master schedule, as the bench sees it.
 *
 * Jobs come from MSSCHED_VIEW - the same view RtMcs renders its schedule page
 * from - so the names, customer, rev and sequence on the panel are literally the
 * ones on the office screen. Nobody has to translate "rev 5450" into "the
 * Schellvac constant kit" in their head.
 *
 * A job is a REV *and* a kit (PHKID). That distinction matters: rev 5450 carries
 * two jobs (Variable, 9 harnesses; Constant Kit, 15), and picking by rev alone
 * would put all 24 in one undifferentiated list.
 */

/** Progress is always counted in BUILD mode. "Completed" on the floor means the
 *  harness is built - it must not change meaning when someone switches the timer
 *  to Setup or Braid, or a whole job would leave the Completed section. */
export const PROGRESS_TIMETYPE = 1;

export interface Job {
    msid: number;
    seq: number;
    jobName: string;
    customer: string | null;
    revNum: number | null;
    /** RID - the key HARNBUILDTIMES.REV and BUILDKITLIST.REV both use. */
    rev: number;
    phkid: number | null;
    phid: number | null;
    status: string;
    targStart: string | null;
    targEnd: string | null;
    harnTotal: number;
    harnReady: number;
    shortLines: number;
    inStock: number;
    unitsTotal: number;
    unitsBuilt: number;
    unitsRunning: number;
}

export interface HarnProgress {
    partNum: string;
    built: number;
    running: number;
}

async function query(sql: string, params: unknown[] = []): Promise<any[] | undefined> {
    try {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query: sql, params }),
        });
        const data = await response.json();
        if (data?.success === false) return undefined;
        return Array.isArray(data?.result) ? data.result : undefined;
    } catch (err) {
        console.log(err);
        return undefined;
    }
}

/** The harnesses belonging to a job, whether it is a kit (PHKID) or a single
 *  scheduled harness (PHID). Written once because three queries need it. */
const HARNESSES_OF_JOB = `
    SELECT PH.HARNPN FROM PROJHARN PH
     WHERE (V.PHKID IS NOT NULL AND PH.RID = V.REV AND PH.KITID = V.PHKID)
        OR (V.PHKID IS NULL AND V.PHID IS NOT NULL AND PH.PHID = V.PHID)`;

const JOBS_SQL = `
SELECT V.MSID, V.SEQ, V.HARNPN AS jobName, V.PHKITNAME, V.CUSTOMER, V.REVNUM, V.REV,
       V.PHKID, V.PHID, V.STATUS, V.TARGSTRTDATE, V.TARGENDDATE,
       COALESCE(V.HARNTOTAL, 0)    AS harnTotal,
       COALESCE(V.HARNREADYCNT, 0) AS harnReady,
       COALESCE(V.SHORTLINES, 0)   AS shortLines,
       COALESCE(V.FILLEDQTY, 0)    AS inStock,
       (SELECT COALESCE(SUM(PH.QTY * PH.ALTQTY), 0) FROM PROJHARN PH
         WHERE (V.PHKID IS NOT NULL AND PH.RID = V.REV AND PH.KITID = V.PHKID)
            OR (V.PHKID IS NULL AND V.PHID IS NOT NULL AND PH.PHID = V.PHID)) AS unitsTotal,
       (SELECT COUNT(*) FROM HARNBUILDTIMES_VIEW T
         WHERE T.REV = V.REV AND T.timeTypeId = ${PROGRESS_TIMETYPE}
           AND T.openSegments = 0 AND T.harnNumber IN (${HARNESSES_OF_JOB})) AS unitsBuilt,
       (SELECT COUNT(*) FROM HARNBUILDTIMES_VIEW T
         WHERE T.REV = V.REV AND T.timeTypeId = ${PROGRESS_TIMETYPE}
           AND T.openSegments > 0 AND T.harnNumber IN (${HARNESSES_OF_JOB})) AS unitsRunning
  FROM MSSCHED_VIEW V
 WHERE V.REV IS NOT NULL
 ORDER BY V.SEQ ASC`;

/** Built and in-progress counts per part number for one job. Kept separate from
 *  the kit itself so the harness list can refresh its numbers without reloading
 *  (and re-broadcasting) the kit the timer is working from. */
const HARN_PROGRESS_SQL = `
SELECT PH.HARNPN AS partNum,
       (SELECT COUNT(*) FROM HARNBUILDTIMES_VIEW T
         WHERE T.harnNumber = PH.HARNPN AND T.REV = PH.RID
           AND T.timeTypeId = ${PROGRESS_TIMETYPE} AND T.openSegments = 0) AS built,
       (SELECT COUNT(*) FROM HARNBUILDTIMES_VIEW T
         WHERE T.harnNumber = PH.HARNPN AND T.REV = PH.RID
           AND T.timeTypeId = ${PROGRESS_TIMETYPE} AND T.openSegments > 0) AS running
  FROM PROJHARN PH
 WHERE PH.RID = ? AND (? IS NULL OR PH.KITID = ?)`;

export function jobIsComplete(job: Job): boolean {
    return job.unitsTotal > 0 && job.unitsBuilt >= job.unitsTotal;
}

export function useJobs() {
    const [jobs, setJobs] = useState<Job[] | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchJobs = useCallback(async () => {
        const rows = await query(JOBS_SQL);
        setLoading(false);
        if (!rows) return;
        setJobs(
            rows.map((r) => ({
                msid: Number(r.MSID),
                seq: Number(r.SEQ ?? 0),
                // MSSCHED.HARNPN holds the JOB name for kit jobs (the kit name),
                // and the part number for single-harness ones.
                jobName: String(r.jobName ?? r.PHKITNAME ?? "(unnamed job)"),
                customer: r.CUSTOMER ?? null,
                revNum: r.REVNUM ?? null,
                rev: Number(r.REV),
                phkid: r.PHKID ?? null,
                phid: r.PHID ?? null,
                status: String(r.STATUS ?? ""),
                targStart: r.TARGSTRTDATE ?? null,
                targEnd: r.TARGENDDATE ?? null,
                harnTotal: Number(r.harnTotal ?? 0),
                harnReady: Number(r.harnReady ?? 0),
                shortLines: Number(r.shortLines ?? 0),
                inStock: Number(r.inStock ?? 0),
                unitsTotal: Number(r.unitsTotal ?? 0),
                unitsBuilt: Number(r.unitsBuilt ?? 0),
                unitsRunning: Number(r.unitsRunning ?? 0),
            }))
        );
    }, []);

    useEffect(() => {
        fetchJobs();
    }, [fetchJobs]);

    return { jobs, loading, fetchJobs };
}

/** Standalone so the harness page can call it without mounting the job list. */
export async function fetchHarnProgress(
    rev: number,
    phkid: number | null
): Promise<Map<string, HarnProgress>> {
    const rows = await query(HARN_PROGRESS_SQL, [rev, phkid, phkid]);
    const map = new Map<string, HarnProgress>();
    if (!rows) return map;
    for (const r of rows) {
        map.set(String(r.partNum), {
            partNum: String(r.partNum),
            built: Number(r.built ?? 0),
            running: Number(r.running ?? 0),
        });
    }
    return map;
}
