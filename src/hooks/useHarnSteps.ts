import { useEffect, useState } from "react";
import { dbEngine } from "../assets/dbEngine";

/**
 * Harness Steps (Randy 2026-10-20, HPP repo docs/HARNESS-STEPS-DESIGN.md):
 * HPP records, per harness revision as priced (harnstepset.harnpn = the exact
 * PN), which timer steps it needs (harnstep.required = 1), and whether its
 * prebuild is shared with other harnesses (harnstepset.prebuildgroup).
 *
 * The tables are PostgreSQL only (0026-harnsteps.sql) and empty until HPP users
 * confirm steps, so every answer here falls back to "nothing known" - the
 * picker then shows its full list, as before.
 */

/** Randy's one fixed shop order (design section 1). */
export const STEP_ORDER = [6, 7, 2, 1, 12, 8, 5, 9, 3, 11];
export const PREBUILD_MODE = 6;
export const STRIP_CRIMP_MODE = 7;
/** Steps whose Submit asks "finished this step for these units?" (design answer D). */
export const STEP_DONE_MODES = [PREBUILD_MODE, STRIP_CRIMP_MODE];

export interface HarnSteps {
    /** Required time type ids, in shop order. Empty = none recorded. */
    required: number[];
    /** harnstepset.prebuildgroup, e.g. "HYSV-20008/9". */
    group: string | null;
    /** Every harness in that group, this one included (2 or more), or []. */
    members: string[];
}

/** A shared prebuild session picked on this panel (shared key "prebuildShare"). */
export interface PrebuildShare {
    /** The harness it was picked on - a different harness turns it off. */
    harn: string;
    group: string;
    members: string[];
}

/** Rows, or null when the query failed (no tables, no grant, no database). */
async function readRows(query: string, params: unknown[]): Promise<any[] | null> {
    try {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, params }),
        });
        const data = await response.json();
        return data?.success === false || !Array.isArray(data?.result) ? null : data.result;
    } catch {
        return null;
    }
}

/** The harness's steps, or null when it has none recorded or they cannot be read. */
export async function readHarnSteps(harnNumber: string): Promise<HarnSteps | null> {
    if (!harnNumber || dbEngine() !== "pg") return null;
    const rows = await readRows(
        `SELECT s.prebuildgroup AS grp, h.timetypeid AS tt
           FROM harnstepset s
           LEFT JOIN harnstep h ON h.harnpn = s.harnpn AND h.required = 1
          WHERE s.harnpn = ?`,
        [harnNumber]
    );
    if (!rows || !rows.length) return null;
    const ids = new Set(rows.map((r) => Number(r.tt)).filter((n) => n > 0));
    const required = STEP_ORDER.filter((id) => ids.has(id));
    const group = rows[0].grp ? String(rows[0].grp) : null;
    let members: string[] = [];
    if (group) {
        const memberRows = await readRows("SELECT harnpn AS pn FROM harnstepset WHERE prebuildgroup = ? ORDER BY harnpn", [group]);
        members = (memberRows ?? []).map((r) => String(r.pn));
        if (members.length < 2 || !members.some((pn) => pn.toUpperCase() === harnNumber.toUpperCase())) members = [];
    }
    return { required, group, members };
}

/** readHarnSteps for the harness on screen, re-read when it changes. */
export function useHarnSteps(harnNumber: string): HarnSteps | null {
    const [steps, setSteps] = useState<HarnSteps | null>(null);
    useEffect(() => {
        let cancelled = false;
        setSteps(null);
        readHarnSteps(harnNumber).then((s) => {
            if (!cancelled) setSteps(s);
        });
        return () => {
            cancelled = true;
        };
    }, [harnNumber]);
    return steps;
}
