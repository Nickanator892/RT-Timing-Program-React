import { execQuery } from "./execQueryFunction";

/**
 * Timer:TimeEdits (Randy 2026-10-16): a time somebody fixed or added by hand
 * on RT-MCS carries a "*" everywhere it is listed - "* under review" until the
 * approver has passed it. A build is marked when an edit that wrote it
 * (HARNTIMEEDITBUILD) is APPROVED or PENDING; PENDING wins (RT-MCS
 * TimeEdits.cs EditMarks). Rejected and superseded edits mark nothing.
 */
export type EditMark = "APPROVED" | "PENDING";

/** Marks by build id; empty when none, or when they cannot be read. */
export async function readEditMarks(buildIds: number[]): Promise<Map<number, EditMark>> {
    const marks = new Map<number, EditMark>();
    const ids = [...new Set(buildIds.map(Number).filter((n) => n > 0))];
    for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const rows = await execQuery(
            `SELECT b.BUILDID AS buildId, e.STATUS AS status
               FROM HARNTIMEEDITBUILD b JOIN HARNTIMEEDIT e ON e.EDITID = b.EDITID
              WHERE b.BUILDID IN (${chunk.map(() => "?").join(",")}) AND e.STATUS IN ('APPROVED', 'PENDING')`,
            chunk
        );
        if (!Array.isArray(rows)) return marks;
        for (const r of rows as any[]) {
            const id = Number(r.buildId);
            const st = String(r.status) as EditMark;
            if (!marks.has(id) || st === "PENDING") marks.set(id, st);
        }
    }
    return marks;
}

/** What follows a marked time's label. */
export const markText = (m: EditMark | undefined) => (m === "PENDING" ? " * under review" : m === "APPROVED" ? " *" : "");
