import { execQuery } from "./execQueryFunction";
import type { User } from "./types/UserType";

/**
 * Crew per segment, and per batch unit (Randy, 2026-10-07: "record hours per
 * person").
 *
 * HARNBUILDSEGCREW holds every person on a segment OTHER than its primary
 * (HARNBUILDSEGMENTS.builderId), so numberOfBuilders = 1 + its rows. The
 * people on a segment never change mid-segment: every crew change rolls. The
 * table belongs to RT-MCS (created in FloorEnsureSchema from 1.0.32, which
 * also lets the Pi write it through /api/timer/exec) and the RT-MCS phone timer
 * writes it to exactly the same rules. SECONDARYBUILDERS keeps its old meaning,
 * the build's latest roster, for compatibility and the one-place trigger.
 *
 * A batch opens one live build at Start and, at Submit, drops it and writes one
 * build per unit. Its crew used to be the roster on screen AT SUBMIT, stamped
 * on every unit: a helper who joined and then left was recorded nowhere, and
 * one who joined late was billed for the whole window. Now every unit gets an
 * equal share of every live segment (rule 3 of the shared contract): a batch
 * is worked on all its units at once, so each unit carries the same labour,
 * and each person's total comes out exactly what they worked.
 */

/** A segment row of the dropped live build, as /api/build/discard returns it. */
export interface DroppedSegment {
    segmentId: number;
    builderId: number | null;
    numberOfBuilders: number | null;
    accumSeconds: number | null;
    startTime?: string | null;
    endTime?: string | null;
}

/** One live segment: the worked seconds it carries and the people on it. */
export interface CrewStretch {
    /** Pause-free seconds the segment earned (its accumSeconds). */
    seconds: number;
    primaryId: number | null;
    /** The other people on it, by name - HARNBUILDSEGCREW. */
    crewIds: number[];
    /** Head-count off the segment row, primary included. More than
     *  crewIds.length + 1 only for a segment written before HARNBUILDSEGCREW
     *  existed whose names are no longer known. */
    numberOfBuilders: number;
}

/** One closed segment of one unit. */
export interface UnitPiece {
    seconds: number;
    /** Share of the unit's wall-clock slice; a unit's pieces sum to 1. */
    share: number;
    primaryId: number | null;
    crewIds: number[];
    numberOfBuilders: number;
}

/** What one batch unit is written with. */
export interface UnitCrew {
    pieces: UnitPiece[];
    /** HARNBUILDTIMES.builderId: whoever was on the build last, as a handover leaves it. */
    builderId: number | null;
    /** SECONDARYBUILDERS for the unit: everyone in the crew of any piece it got,
     *  so a helper who left before Submit still shows on the units they worked
     *  (the Hub names crew from this table). Never the unit's builder. */
    secondaryIds: number[];
    /** HARNBUILDTIMES.numberOfBuilders: the most people on any of its pieces (display only - labour comes from the segments). */
    numberOfBuilders: number;
}

const toIds = (list: unknown[] | null | undefined): number[] =>
    (Array.isArray(list) ? list : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);

/**
 * The live build's segments, oldest first, with who was on each.
 *
 * Names come from HARNBUILDSEGCREW. A segment with none there (one opened
 * before the table existed) takes SECONDARYBUILDERS if it is the latest
 * segment - that is exactly its roster - and otherwise keeps its head-count
 * with no names: the labour stays right and nobody is guessed onto a unit.
 * The open segment's seconds are main's live count when that is higher - the
 * database only has them to the last heartbeat (same rule as a single Submit).
 */
export function resolveCrewStretches(args: {
    segments: DroppedSegment[];
    /** HARNBUILDSEGCREW rows of the build; null when the table does not exist yet. */
    segCrew: { segmentId: number; builderId: number }[] | null;
    /** SECONDARYBUILDERS of the build when it was dropped: the latest segment's crew. */
    currentCrewIds: number[];
    openSegmentSeconds: number;
}): CrewStretch[] {
    const rows = [...(args.segments ?? [])].sort((a, b) => Number(a.segmentId) - Number(b.segmentId));
    const lastId = rows.length ? Number(rows[rows.length - 1].segmentId) : 0;
    return rows.map((s) => {
        const segmentId = Number(s.segmentId);
        const primaryId = Number(s.builderId) > 0 ? Number(s.builderId) : null;
        let seconds = Math.max(0, Number(s.accumSeconds) || 0);
        if (String(s.endTime ?? "") === "") {
            seconds = Math.max(seconds, Math.max(0, Math.round(Number(args.openSegmentSeconds) || 0)));
        }
        const others = (list: unknown[]) => [...new Set(toIds(list))].filter((id) => id !== primaryId);
        const recorded = others(
            (args.segCrew ?? []).filter((r) => Number(r?.segmentId) === segmentId).map((r) => r.builderId)
        );
        const dbCount = Math.max(1, Math.floor(Number(s.numberOfBuilders) || 1));
        let crewIds = recorded;
        if (!crewIds.length && dbCount > 1 && segmentId === lastId) {
            const roster = others(args.currentCrewIds);
            if (roster.length + 1 === dbCount) crewIds = roster;
        }
        return { seconds, primaryId, crewIds, numberOfBuilders: Math.max(dbCount, crewIds.length + 1) };
    });
}

/**
 * Rule 3 of the shared crew contract: every unit gets an equal share of every
 * live segment. For segment j with a_j worked seconds, unit k gets
 * floor(a_j / units) seconds plus one of the a_j mod units leftover seconds if
 * it is among the first ones, so the per-segment sums are exact. Each piece
 * keeps its segment's primary, head-count and crew; the pieces sit back to
 * back inside the unit's own wall-clock slice, each as long as its share of
 * THAT unit's seconds. A segment with no worked seconds is skipped, and so is
 * a piece that comes to 0 s for this unit (fewer seconds than units); a unit
 * that gets 0 s overall carries one 0 s piece of the latest segment. With no
 * crew change at all, every unit is one piece, as before. The RT-MCS phone
 * timer splits the same way (agreed 2026-10-07).
 */
export function crewPerUnit(stretches: CrewStretch[], units: number): UnitCrew[] {
    const n = Math.max(1, Math.floor(units));
    if (!stretches.length) return [];
    const live = stretches.map((s) => ({ ...s, seconds: Math.max(0, Math.round(s.seconds)) }));
    const worked = live.filter((s) => s.seconds > 0);
    const last = live[live.length - 1];
    const result: UnitCrew[] = [];
    for (let k = 0; k < n; k++) {
        let pieces = worked
            .map((s) => ({
                seconds: Math.floor(s.seconds / n) + (k < s.seconds % n ? 1 : 0),
                weight: s.seconds,
                primaryId: s.primaryId,
                crewIds: s.crewIds,
                numberOfBuilders: s.numberOfBuilders,
            }))
            .filter((p) => p.seconds > 0);
        // Fewer seconds on record than units (or none at all): the unit still
        // exists, carrying the latest segment's people and 0 s.
        if (!pieces.length) {
            pieces = [
                { seconds: 0, weight: 1, primaryId: last.primaryId, crewIds: last.crewIds, numberOfBuilders: last.numberOfBuilders },
            ];
        }
        const unitSeconds = pieces.reduce((t, p) => t + p.seconds, 0);
        const builderId = last.primaryId;
        const secondaryIds: number[] = [];
        for (const p of pieces) {
            for (const id of p.crewIds) {
                if (id !== builderId && !secondaryIds.includes(id)) secondaryIds.push(id);
            }
        }
        result.push({
            pieces: pieces.map((p) => ({
                seconds: p.seconds,
                share: unitSeconds > 0 ? p.seconds / unitSeconds : 1 / pieces.length,
                primaryId: p.primaryId,
                crewIds: [...p.crewIds],
                numberOfBuilders: p.numberOfBuilders,
            })),
            builderId,
            secondaryIds,
            numberOfBuilders: pieces.reduce((m, p) => Math.max(m, p.numberOfBuilders), 1),
        });
    }
    return result;
}

// --- One place at a time: who, and where --------------------------------------

export interface OpenElsewhere {
    builderId: number;
    name: string;
    /** The build that blocks them - what an RT-MCS release is asked to end. */
    buildId: number;
    /** Its primary (a release ends and submits it) or only crew on it (a release takes them off it). */
    isPrimary: boolean;
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
        `SELECT b.Id AS builderId, b.userName AS name, s.buildId AS buildId, s.stationId AS stationId,
                h.harnNumber AS harnNumber, CASE WHEN s.builderId = b.Id THEN 1 ELSE 0 END AS isPrimary
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
            buildId: Number(r.buildId) || 0,
            isPrimary: Number(r.isPrimary) === 1,
            stationId: String(r.stationId ?? ""),
            harnNumber: String(r.harnNumber ?? ""),
        });
    }
    return out;
}

const whereOpen = (stationId: string) =>
    stationId === "RT-MCS phone" ? "on the RT-MCS phone timer" : `on timer station ${stationId}`;

export function describeOpenElsewhere(o: OpenElsewhere): string {
    return `${o.name} already has a build open ${whereOpen(o.stationId)}${o.harnNumber ? ` (${o.harnNumber})` : ""}`;
}

/** What the release button does, in its words: "End & submit ashley's time on
 *  the RT-MCS phone timer", or "Take ashley off the build on ..." when they are
 *  only crew there (RT-MCS then rolls them off and leaves its builder timing). */
export function describeBlockingTime(o: OpenElsewhere): string {
    return o.isPrimary
        ? `End & submit ${o.name}'s time ${whereOpen(o.stationId)}`
        : `Take ${o.name} off the build ${whereOpen(o.stationId)}`;
}

/** True when an error is RT-MCS's one-place-at-a-time refusal. */
export const isOnePlaceRefusal = (e: unknown) =>
    /ONE PLACE AT A TIME/i.test(String((e as any)?.message ?? e ?? ""));

/**
 * The crew and primary the database holds for a live build right now: the
 * open segment's builder and the build's SECONDARYBUILDERS. `live: false` when
 * the build has no open segment at all. null when it cannot be read.
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
    const rows = await execQuery(`SELECT Id, userName, password, privLevel FROM HARNBUILDERS WHERE Id = ?`, [id]);
    const r = Array.isArray(rows) ? (rows as any[])[0] : null;
    if (!r) return null;
    return { Id: Number(r.Id), name: String(r.userName ?? ""), password: r.password ?? undefined, privLevel: r.privLevel ?? undefined };
}

// --- A live build closed from somewhere else -----------------------------------

/** The latest MSTIMERRELEASE row for a build (RT-MCS's audit of a release). */
export interface ReleaseAudit {
    action: string;
    station: string;
    via: string;
    at: string;
    byName: string;
    whoName: string;
}

export type LiveBuildState =
    | { kind: "open" }
    /** Our segment was closed but the build goes on: RT-MCS dropped a crew member and opened the next segment here. */
    | { kind: "adopt"; segmentId: number; startTime: string; closedAccum: number; release: ReleaseAudit | null }
    /** Every segment of the build is closed: it was ended (by a release, or it was already submitted). */
    | { kind: "ended"; harnNumber: string; endTime: string; release: ReleaseAudit | null }
    | { kind: "missing" }
    | { kind: "unknown" };

async function readReleaseAudit(buildId: number): Promise<ReleaseAudit | null> {
    // MSTIMERRELEASE arrives with RT-MCS 1.0.32; before that this read just
    // fails and there is no audit to quote.
    const rows = await execQuery(
        `SELECT r.ACTION AS action, r.STATION AS station, r.VIA AS via, r.AT AS at,
                rb.userName AS byName, rw.userName AS whoName
           FROM MSTIMERRELEASE r
           LEFT JOIN HARNBUILDERS rb ON rb.Id = r.BYBUILDERID
           LEFT JOIN HARNBUILDERS rw ON rw.Id = r.BUILDERID
          WHERE r.BUILDID = ?
          ORDER BY r.ID DESC LIMIT 1`,
        [buildId]
    );
    const r = Array.isArray(rows) ? (rows as any[])[0] : null;
    if (!r) return null;
    return {
        action: String(r.action ?? ""),
        station: String(r.station ?? ""),
        via: String(r.via ?? ""),
        at: String(r.at ?? ""),
        byName: String(r.byName ?? ""),
        whoName: String(r.whoName ?? ""),
    };
}

/** "from the RT-MCS phone timer by caleb at 14:02". VIA is where the release
 *  was asked from ('phone' or 'station:<name>'); STATION is where the released
 *  build was open, which for this panel's own build is this panel. */
export function describeRelease(a: ReleaseAudit): string {
    const station = /^station:(.+)$/i.exec(a.via)?.[1];
    const where = /^phone$/i.test(a.via)
        ? "from the RT-MCS phone timer"
        : station
          ? `from timer station ${station}`
          : "from another timer";
    const at = /(\d{2}:\d{2})(:\d{2})?\s*$/.exec(a.at)?.[1];
    return `${where}${a.byName ? ` by ${a.byName}` : ""}${at ? ` at ${at}` : ""}`;
}

/**
 * What became of this panel's live build. Asked whenever a write aimed at its
 * segment finds nothing open (a heartbeat or close changing 0 rows, a roll
 * refused for the same reason): RT-MCS can now end a blocking build, or drop
 * someone off its crew, from the phone timer or another station (Randy,
 * 2026-10-07: "anyone can end/submit a blocking time").
 */
export async function readLiveBuild(buildId: number, segmentId: number): Promise<LiveBuildState> {
    let id = Number(buildId) || 0;
    if (!id && Number(segmentId) > 0) {
        const own = await execQuery(`SELECT buildId FROM HARNBUILDSEGMENTS WHERE segmentId = ?`, [segmentId]);
        if (!Array.isArray(own)) return { kind: "unknown" };
        if (!own.length) return { kind: "missing" };
        id = Number((own as any[])[0].buildId) || 0;
    }
    if (!id) return { kind: "missing" };
    const rows = await execQuery(
        `SELECT s.segmentId, s.endTime, s.accumSeconds, s.startTime, b.harnNumber
           FROM HARNBUILDSEGMENTS s LEFT JOIN HARNBUILDS b ON b.buildId = s.buildId
          WHERE s.buildId = ? ORDER BY s.segmentId`,
        [id]
    );
    if (!Array.isArray(rows)) return { kind: "unknown" };
    if (!rows.length) return { kind: "missing" };
    const all = rows as any[];
    const isOpen = (r: any) => String(r.endTime ?? "") === "";
    const mine = all.find((r) => Number(r.segmentId) === Number(segmentId));
    if (mine && isOpen(mine)) return { kind: "open" };
    const open = all.filter(isOpen);
    if (open.length) {
        const next = open[open.length - 1];
        return {
            kind: "adopt",
            segmentId: Number(next.segmentId),
            startTime: String(next.startTime ?? ""),
            closedAccum: Math.max(0, Number(mine?.accumSeconds) || 0),
            release: await readReleaseAudit(id),
        };
    }
    const lastRow = all[all.length - 1];
    return {
        kind: "ended",
        harnNumber: String(lastRow.harnNumber ?? ""),
        endTime: String(lastRow.endTime ?? ""),
        release: await readReleaseAudit(id),
    };
}
