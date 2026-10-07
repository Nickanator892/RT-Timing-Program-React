import { execQuery } from "./execQueryFunction";
import type { User } from "./types/UserType";

/**
 * Crew per batch unit (Randy, 2026-10-07).
 *
 * A batch opens one live build at Start and, at Submit, drops it and writes one
 * build per unit with the timed window sliced evenly across them. Its crew used
 * to be the roster on screen AT SUBMIT, stamped on every unit: a helper who
 * joined and then left was recorded nowhere, and one who joined late was billed
 * for the whole window. The live build's segments already say who worked each
 * stretch - every crew change rolls a segment - so the units are cut from them.
 *
 * SECONDARYBUILDERS is per build and every roll replaces it, so once a helper
 * has left, the database no longer names who was on the earlier segments. The
 * page keeps that itself (`segmentCrew`, one entry per segment it opened,
 * written only from what /api/build/start and /api/build/segment-roll report
 * they COMMITTED) and it is believed only where it agrees with the segment row.
 * The database stays the authority on head-count and primary: a segment whose
 * names are not known keeps its numberOfBuilders with no names, so the labour
 * is still right and nobody is ever guessed onto a unit.
 */

/** One entry per segment this panel opened: who the database put on it. */
export interface SegmentCrewEntry {
    buildId: number;
    segmentId: number;
    primaryId: number | null;
    crewIds: number[];
}

/** A segment row of the dropped live build, as /api/build/discard returns it. */
export interface DroppedSegment {
    segmentId: number;
    builderId: number | null;
    numberOfBuilders: number | null;
    accumSeconds: number | null;
    startTime?: string | null;
    endTime?: string | null;
}

/** One stretch of worked time and the people on it. */
export interface CrewStretch {
    /** Pause-free seconds the stretch earned (its segment's accumSeconds). */
    seconds: number;
    primaryId: number | null;
    /** Second operators the database is known to have held for the stretch. */
    crewIds: number[];
    /** Head-count off the segment row, primary included. More than
     *  crewIds.length + 1 only when a closed segment's names are not known. */
    numberOfBuilders: number;
}

/** One closed segment of one unit. */
export interface UnitPiece {
    /** Share of the unit's wall-clock slice; a unit's pieces sum to 1. */
    share: number;
    seconds: number;
    primaryId: number | null;
    crewIds: number[];
    numberOfBuilders: number;
}

/** What one unit is written with: its segments, its build-row builder and crew. */
export interface UnitCrew {
    pieces: UnitPiece[];
    builderId: number | null;
    secondaryIds: number[];
    numberOfBuilders: number;
}

const toIds = (list: unknown[] | null | undefined): number[] =>
    (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);

/**
 * The live build's segments as stretches of worked time, oldest first.
 * The open segment's seconds are main's live count when that is higher - the
 * database only has them to the last heartbeat (same rule as a single Submit).
 */
export function resolveCrewStretches(args: {
    buildId: number;
    segments: DroppedSegment[];
    /** SECONDARYBUILDERS of the build when it was dropped: the latest segment's crew. */
    currentCrewIds: number[];
    log: SegmentCrewEntry[];
    openSegmentSeconds: number;
}): CrewStretch[] {
    const rows = [...(args.segments ?? [])].sort((a, b) => Number(a.segmentId) - Number(b.segmentId));
    const lastId = rows.length ? Number(rows[rows.length - 1].segmentId) : 0;
    return rows.map((s) => {
        const segmentId = Number(s.segmentId);
        const primaryId = Number(s.builderId) > 0 ? Number(s.builderId) : null;
        const numberOfBuilders = Math.max(1, Math.floor(Number(s.numberOfBuilders) || 1));
        let seconds = Math.max(0, Number(s.accumSeconds) || 0);
        if (String(s.endTime ?? "") === "") {
            seconds = Math.max(seconds, Math.max(0, Math.round(Number(args.openSegmentSeconds) || 0)));
        }
        const others = (list: unknown[]) => [...new Set(toIds(list))].filter((id) => id !== primaryId);
        const fits = (list: number[]) => list.length + 1 === numberOfBuilders;

        let crewIds: number[] = [];
        const fromDb = segmentId === lastId ? others(args.currentCrewIds) : null;
        if (fromDb && fits(fromDb)) {
            crewIds = fromDb;
        } else {
            const entry = (args.log ?? []).find(
                (e) => Number(e?.buildId) === Number(args.buildId) && Number(e?.segmentId) === segmentId
            );
            const logged =
                entry && (Number(entry.primaryId) > 0 ? Number(entry.primaryId) : null) === primaryId
                    ? others(entry.crewIds)
                    : null;
            if (logged && fits(logged)) crewIds = logged;
        }
        return { seconds, primaryId, crewIds, numberOfBuilders };
    });
}

const sameCrew = (a: Omit<UnitPiece, "share" | "seconds">, b: Omit<UnitPiece, "share" | "seconds">) =>
    a.primaryId === b.primaryId &&
    a.numberOfBuilders === b.numberOfBuilders &&
    [...a.crewIds].sort((x, y) => x - y).join(",") === [...b.crewIds].sort((x, y) => x - y).join(",");

function mergeAdjacent(pieces: UnitPiece[]): UnitPiece[] {
    const out: UnitPiece[] = [];
    for (const p of pieces) {
        const last = out[out.length - 1];
        if (last && sameCrew(last, p)) {
            last.share += p.share;
            last.seconds += p.seconds;
        } else {
            out.push({ ...p, crewIds: [...p.crewIds] });
        }
    }
    return out;
}

/**
 * Cut the stretches into `units` equal shares of WORKED time and say who is on
 * each. Worked time, not wall clock: a helper who was only there while the
 * clock was paused earns nothing, and the seconds credited to each person add
 * up to the seconds they were on the segments.
 *
 * Each unit gets one piece per crew stretch inside its share (neighbours with
 * the same people merged, a stretch that rounds to 0 s dropped), and every
 * piece becomes one closed segment carrying its own builderId,
 * numberOfBuilders and seconds - the row shape a single build has after a
 * mid-run roll, so HARNBUILDTIMES_VIEW.laborSeconds stays exact. With no crew
 * change at all every unit is one piece, which is exactly what was written
 * before this existed.
 *
 * @param unitSeconds the seconds each unit is credited (already rounded); the
 *   pieces of a unit always add up to exactly this.
 */
export function crewPerUnit(stretches: CrewStretch[], units: number, unitSeconds: number): UnitCrew[] {
    const n = Math.max(1, Math.floor(units));
    if (!stretches.length) return [];
    const total = stretches.reduce((t, s) => t + Math.max(0, s.seconds), 0);
    // Nothing earned on record at all: the whole run is the latest stretch.
    const weights = stretches.map((s, i) =>
        total > 0 ? Math.max(0, s.seconds) : i === stretches.length - 1 ? 1 : 0
    );
    const sum = weights.reduce((a, b) => a + b, 0);
    const ends: number[] = [];
    let acc = 0;
    weights.forEach((w, i) => {
        acc += w;
        ends.push(i === weights.length - 1 ? 1 : acc / sum);
    });

    const result: UnitCrew[] = [];
    for (let k = 0; k < n; k++) {
        const lo = k / n;
        const hi = (k + 1) / n;
        let pieces: UnitPiece[] = [];
        stretches.forEach((s, i) => {
            const overlap = Math.min(ends[i], hi) - Math.max(i === 0 ? 0 : ends[i - 1], lo);
            if (overlap > 1e-12) {
                pieces.push({
                    share: overlap * n,
                    seconds: 0,
                    primaryId: s.primaryId,
                    crewIds: s.crewIds,
                    numberOfBuilders: s.numberOfBuilders,
                });
            }
        });
        if (!pieces.length) {
            const s = stretches[stretches.length - 1];
            pieces = [{ share: 1, seconds: 0, primaryId: s.primaryId, crewIds: s.crewIds, numberOfBuilders: s.numberOfBuilders }];
        }
        pieces = mergeAdjacent(pieces);

        // Cumulative rounding: the pieces add up to exactly unitSeconds.
        let cum = 0;
        let prev = 0;
        pieces.forEach((p, j) => {
            cum += p.share;
            const upTo = j === pieces.length - 1 ? unitSeconds : Math.round(unitSeconds * Math.min(1, cum));
            p.seconds = Math.max(0, upTo - prev);
            prev = Math.max(prev, upTo);
        });
        if (pieces.some((p) => p.seconds > 0)) {
            pieces = mergeAdjacent(pieces.filter((p) => p.seconds > 0));
        } else {
            pieces = [pieces.reduce((best, p) => (p.share > best.share ? p : best))];
        }
        // The wall-clock slice is split the way the seconds are.
        const shareTotal = pieces.reduce((t, p) => t + p.share, 0) || 1;
        pieces.forEach((p) => {
            p.share = unitSeconds > 0 ? p.seconds / unitSeconds : p.share / shareTotal;
        });

        // The build row goes to whoever was the primary for most of the unit
        // (the later one on a tie, as a handover's build row follows the
        // person who took it). Second operators are everyone named on a piece;
        // nobody is the builder AND a second operator.
        const byPrimary = new Map<number | null, number>();
        pieces.forEach((p) => byPrimary.set(p.primaryId, (byPrimary.get(p.primaryId) ?? 0) + p.seconds));
        let builderId = pieces[pieces.length - 1].primaryId;
        for (const p of pieces) {
            if ((byPrimary.get(p.primaryId) ?? 0) > (byPrimary.get(builderId) ?? 0)) builderId = p.primaryId;
        }
        const secondaryIds: number[] = [];
        for (const p of pieces) {
            for (const id of p.crewIds) {
                if (id !== builderId && !secondaryIds.includes(id)) secondaryIds.push(id);
            }
        }
        const unnamed = pieces.reduce((m, p) => Math.max(m, p.numberOfBuilders - 1 - p.crewIds.length), 0);
        result.push({ pieces, builderId, secondaryIds, numberOfBuilders: 1 + secondaryIds.length + unnamed });
    }
    return result;
}

// --- One place at a time: who, and where --------------------------------------

export interface OpenElsewhere {
    builderId: number;
    name: string;
    stationId: string;
    harnNumber: string;
}

/**
 * Which of these builders has a build open on another build - the condition
 * RT-MCS's TRG_TIMER_ONE_PLACE_* triggers refuse on. Their message names
 * nobody; this is how the panel says who. Read-only; [] when the read fails.
 */
export async function findOpenElsewhere(builderIds: number[], excludeBuildId: number): Promise<OpenElsewhere[]> {
    const list = [...new Set(toIds(builderIds))];
    if (!list.length) return [];
    const rows = await execQuery(
        `SELECT b.Id AS builderId, b.userName AS name, s.stationId AS stationId, h.harnNumber AS harnNumber
           FROM HARNBUILDERS b
           JOIN HARNBUILDSEGMENTS s
             ON COALESCE(s.endTime, '') = '' AND s.stationId IS NOT NULL AND s.buildId <> ?
            AND (s.builderId = b.Id
                 OR EXISTS (SELECT 1 FROM SECONDARYBUILDERS sb WHERE sb.buildId = s.buildId AND sb.builderId = b.Id))
           LEFT JOIN HARNBUILDS h ON h.buildId = s.buildId
          WHERE b.Id IN (${list.map(() => "?").join(",")})
          ORDER BY s.segmentId DESC`,
        [Number(excludeBuildId) || 0, ...list]
    );
    if (!Array.isArray(rows)) return [];
    const seen = new Set<number>();
    const out: OpenElsewhere[] = [];
    for (const r of rows as any[]) {
        const id = Number(r.builderId);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
            builderId: id,
            name: String(r.name ?? `builder ${id}`),
            stationId: String(r.stationId ?? ""),
            harnNumber: String(r.harnNumber ?? ""),
        });
    }
    return out;
}

export function describeOpenElsewhere(o: OpenElsewhere): string {
    const where = o.stationId === "RT-MCS phone" ? "on the RT-MCS phone timer" : `on timer station ${o.stationId}`;
    return `${o.name} already has a build open ${where}${o.harnNumber ? ` (${o.harnNumber})` : ""}`;
}

/** True when an error is RT-MCS's one-place-at-a-time refusal. */
export const isOnePlaceRefusal = (e: unknown) =>
    /ONE PLACE AT A TIME/i.test(String((e as any)?.message ?? e ?? ""));

/**
 * The crew and primary the database holds for a live build right now: the
 * open segment's builder and the build's SECONDARYBUILDERS. `live: false` when
 * the build has no open segment at all (the page's ids are stale - its time
 * will be recorded as a new build, whose Start the database checks again).
 * null when it cannot be read (the caller falls back to what was on screen
 * before the change).
 */
export async function readRecordedCrew(
    buildId: number
): Promise<
    { live: true; primaryId: number | null; crew: { Id: number; name: string }[] } | { live: false } | null
> {
    if (!(Number(buildId) > 0)) return { live: false };
    const seg = await execQuery(
        `SELECT builderId FROM HARNBUILDSEGMENTS
          WHERE buildId = ? AND COALESCE(endTime, '') = '' ORDER BY segmentId DESC LIMIT 1`,
        [buildId]
    );
    const crew = await execQuery(
        `SELECT B.Id AS Id, B.userName AS name
           FROM SECONDARYBUILDERS S JOIN HARNBUILDERS B ON B.Id = S.builderId
          WHERE S.buildId = ? ORDER BY S.secondaryBuilderId`,
        [buildId]
    );
    if (!Array.isArray(seg) || !Array.isArray(crew)) return null;
    if (!seg.length) return { live: false };
    const primaryId = Number((seg as any[])[0]?.builderId) > 0 ? Number((seg as any[])[0].builderId) : null;
    return {
        live: true,
        primaryId,
        crew: (crew as any[])
            .map((r) => ({ Id: Number(r.Id), name: String(r.name ?? "") }))
            .filter((r) => r.Id > 0 && r.Id !== primaryId),
    };
}

/** A builder row in the shape login and the handover control use. */
export async function readBuilder(id: number): Promise<User | null> {
    const rows = await execQuery(
        `SELECT Id, userName, password, privLevel FROM HARNBUILDERS WHERE Id = ?`,
        [id]
    );
    const r = Array.isArray(rows) ? (rows as any[])[0] : null;
    if (!r) return null;
    return { Id: Number(r.Id), name: String(r.userName ?? ""), password: r.password ?? undefined, privLevel: r.privLevel ?? undefined };
}
