import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";
import { useBuildKit } from "../../hooks/useBuildKit";
import { execQuery } from "../../assets/execQueryFunction";
import { sinceText } from "../../assets/crewSlices";
import type { Job } from "../../hooks/useJobs";
import "./packagingSession.css";

/**
 * Packaging sessions (Timer:SharedSessions, Randy 2026-10-16, design section 2
 * in the HPP repo's docs/TIMER-PAUSE-PACKAGING-EDIT-DESIGN.md).
 *
 * Packaging is done for a job, not a harness: pick the job's harnesses being
 * packed and how many of each (default: every one not fully shipped, the
 * quantity still to ship), time it as ONE live build, and Submit splits that
 * time into one unit per quantity, each on its own harness - so each harness
 * gets its quantity's share, and repeat sessions on a harness add up. The rows
 * are the RT-MCS phone timer's (HARNPACKSESSION / HARNPACKSESSIONPN), with
 * this station's name on them.
 *
 * Other people's open sessions come first (the phone's join prompt before the
 * job pick). A panel cannot put its operator onto a clock that runs on another
 * timer, so "Pack the same here" starts this station's own session on that
 * job and those harnesses, which adds up with theirs.
 */

export interface PackRow {
    pn: string;
    owed: number;
    shipped: number;
    qty: number;
    on: boolean;
}

/** The checklist being filled in, before Start. */
export interface PackDraft {
    msid: number;
    rev: number;
    job: string;
    rows: PackRow[];
}

/** The session running on this panel. */
export interface PackSession {
    buildId: number;
    packId: number;
    msid: number;
    rev: number;
    job: string;
    pns: { pn: string; qty: number }[];
}

/** One unit per checked quantity, in checklist order (RT-MCS SubmitCore unitHarns). */
export function expandPackUnits(pns: { pn: string; qty: number }[]): string[] {
    const out: string[] = [];
    for (const p of pns) for (let i = 0; i < Math.max(0, Math.floor(p.qty)) && out.length < 500; i++) out.push(p.pn);
    return out;
}

/** The OPEN session whose live build this is: null when there is none,
 *  undefined when it could not be read. */
export async function readPackOfBuild(buildId: number): Promise<PackSession | null | undefined> {
    const head = await execQuery(
        `SELECT p.PACKID AS packId, p.MSID AS msid, p.REV AS rev, (SELECT m.HARNPN FROM MSSCHED m WHERE m.MSID = p.MSID) AS job
           FROM HARNPACKSESSION p WHERE p.BUILDID = ? AND p.STATUS = 'OPEN' ORDER BY p.PACKID DESC LIMIT 1`,
        [buildId]
    );
    if (!Array.isArray(head)) return undefined;
    const h = (head as any[])[0];
    if (!h) return null;
    const rows = await execQuery(
        `SELECT PN AS pn, QTY AS qty FROM HARNPACKSESSIONPN WHERE PACKID = ? AND QTY > 0 ORDER BY SEQ, PN`,
        [Number(h.packId)]
    );
    if (!Array.isArray(rows)) return undefined;
    return {
        buildId,
        packId: Number(h.packId),
        msid: Number(h.msid),
        rev: Number(h.rev) || 0,
        job: String(h.job ?? ""),
        pns: (rows as any[]).map((r) => ({ pn: String(r.pn), qty: Number(r.qty) || 0 })),
    };
}

interface OpenPack {
    packId: number;
    msid: number;
    rev: number;
    job: string;
    who: string;
    station: string;
    since: string;
    pns: { pn: string; qty: number }[];
}

/** Every OPEN session with a live build, anywhere (RT-MCS FloorPacks). */
async function readOpenPacks(): Promise<OpenPack[]> {
    const head = await execQuery(
        `SELECT p.PACKID AS packId, p.MSID AS msid, p.REV AS rev,
                (SELECT m.HARNPN FROM MSSCHED m WHERE m.MSID = p.MSID) AS job,
                (SELECT b.userName FROM HARNBUILDSEGMENTS s JOIN HARNBUILDERS b ON b.Id = s.builderId
                  WHERE s.buildId = p.BUILDID AND COALESCE(s.endTime, '') = '' ORDER BY s.segmentId DESC LIMIT 1) AS who,
                (SELECT s.stationId FROM HARNBUILDSEGMENTS s
                  WHERE s.buildId = p.BUILDID AND COALESCE(s.endTime, '') = '' ORDER BY s.segmentId DESC LIMIT 1) AS station,
                (SELECT MIN(s.startTime) FROM HARNBUILDSEGMENTS s WHERE s.buildId = p.BUILDID) AS since
           FROM HARNPACKSESSION p
          WHERE p.STATUS = 'OPEN'
            AND EXISTS (SELECT 1 FROM HARNBUILDSEGMENTS s WHERE s.buildId = p.BUILDID AND COALESCE(s.endTime, '') = '')
          ORDER BY p.PACKID`
    );
    if (!Array.isArray(head) || !head.length) return [];
    const ids = (head as any[]).map((h) => Number(h.packId));
    const rows = await execQuery(
        `SELECT PACKID AS packId, PN AS pn, QTY AS qty FROM HARNPACKSESSIONPN
          WHERE PACKID IN (${ids.map(() => "?").join(",")}) AND QTY > 0 ORDER BY SEQ, PN`,
        ids
    );
    const pnRows = Array.isArray(rows) ? (rows as any[]) : [];
    return (head as any[]).map((h) => ({
        packId: Number(h.packId),
        msid: Number(h.msid),
        rev: Number(h.rev) || 0,
        job: String(h.job ?? ""),
        who: String(h.who ?? "someone"),
        station: String(h.station ?? ""),
        since: String(h.since ?? ""),
        pns: pnRows
            .filter((r) => Number(r.packId) === Number(h.packId))
            .map((r) => ({ pn: String(r.pn), qty: Number(r.qty) || 0 })),
    }));
}

const where = (station: string) => (station === "RT-MCS phone" ? "on the phone timer" : `on timer station ${station}`);
const units = (rows: { qty: number }[]) => rows.reduce((t, r) => t + Math.max(0, Math.floor(r.qty)), 0);

type Props = {
    open: boolean;
    setOpen: (open: boolean) => void;
    /** No build on this panel: the checklist can be changed. */
    idle: boolean;
    draft: PackDraft | null;
    setDraft: (draft: PackDraft | null) => void;
    /** The session timing now, if any. */
    session: PackSession | null;
};

function PackagingSession({ open, setOpen, idle, draft, setDraft, session }: Props) {
    const nav = useNavigate();
    const { buildKit } = useBuildKit();
    const [selectedJob] = useSharedState<Job | null>("selectedJob", null);
    const [step, setStep] = useState<"join" | "pick">("join");
    const [others, setOthers] = useState<OpenPack[] | null>(null);
    const [rows, setRows] = useState<PackRow[] | null>(null);
    const [target, setTarget] = useState<{ msid: number; rev: number; job: string } | null>(null);

    // Opening starts at the join list; with nobody else packaging it goes
    // straight on to the checklist.
    useEffect(() => {
        if (!open || !idle) return;
        let alive = true;
        setStep("join");
        setOthers(null);
        readOpenPacks()
            .then((list) => {
                if (!alive) return;
                setOthers(list);
                if (!list.length) beginPick(null);
            })
            .catch(() => {
                if (alive) void beginPick(null);
            });
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, idle]);

    /** The checklist: a session's own harnesses and quantities ("Pack the same
     *  here"), the draft already made for this job, or the selected job's
     *  harnesses with what is still to ship. */
    async function beginPick(from: OpenPack | null) {
        setStep("pick");
        setRows(null);
        if (from) {
            setTarget({ msid: from.msid, rev: from.rev, job: from.job });
            setRows(from.pns.map((p) => ({ pn: p.pn, owed: 0, shipped: 0, qty: p.qty, on: p.qty > 0 })));
            return;
        }
        const job = selectedJob;
        if (!job?.msid || !buildKit) {
            setTarget(null);
            setRows([]);
            return;
        }
        setTarget({ msid: job.msid, rev: Number(job.rev ?? buildKit.REV), job: job.jobName });
        if (draft && draft.msid === job.msid && draft.rows.length) {
            setRows(draft.rows);
            return;
        }
        let ship: { pn: string; owed: number; shipped: number }[] = [];
        try {
            const r = await fetch(`http://localhost:5000/api/jobs/shipstate?msid=${encodeURIComponent(String(job.msid))}`);
            const d = await r.json();
            if (d?.success && Array.isArray(d.pns)) ship = d.pns;
        } catch {
            /* the scheduled quantities stand in */
        }
        const seen = new Set<string>();
        const list: PackRow[] = [];
        for (const h of buildKit.harnesses) {
            if (!h.partNum || seen.has(h.partNum)) continue;
            seen.add(h.partNum);
            const s = ship.find((x) => x.pn === h.partNum);
            const owed = s && s.owed > 0 ? s.owed : Number(h.buildNumber) || 0;
            const shipped = s ? s.shipped : 0;
            const left = Math.max(0, Math.round(owed - shipped));
            list.push({ pn: h.partNum, owed: Math.round(owed), shipped: Math.round(shipped), qty: left, on: left > 0 });
        }
        setRows(list);
    }

    function setRow(i: number, change: Partial<PackRow>) {
        setRows((prev) => {
            if (!prev) return prev;
            const next = [...prev];
            const r = { ...next[i], ...change };
            r.qty = Math.max(0, Math.min(500, Math.floor(Number(r.qty) || 0)));
            if (change.qty !== undefined) r.on = r.qty > 0;
            next[i] = r;
            return next;
        });
    }

    function done() {
        if (!target || !rows) return;
        const picked = rows.filter((r) => r.on && r.qty > 0);
        setDraft(picked.length ? { ...target, rows } : null);
        setOpen(false);
    }

    const checked = draft?.rows.filter((r) => r.on && r.qty > 0) ?? [];

    return (
        <div className="pack-session">
            {session ? (
                <div className="pack-summary" role="status">
                    <span className="pack-label">PACKAGING {session.job}</span>
                    <span className="pack-pns">
                        {session.pns.map((p) => `${p.pn} x${p.qty}`).join(", ")} - {units(session.pns)} units
                    </span>
                </div>
            ) : (
                <div className="pack-summary">
                    <span className="pack-label">PACKAGING</span>
                    <span className="pack-pns">
                        {checked.length
                            ? `${draft?.job}: ${checked.length} harness${checked.length === 1 ? "" : "es"}, ${units(checked)} units`
                            : "Pick the harnesses you are packaging"}
                    </span>
                    {idle && (
                        <button type="button" className="pack-pick" onClick={() => setOpen(true)}>
                            {checked.length ? "Change..." : "Pick harnesses..."}
                        </button>
                    )}
                </div>
            )}

            {open && idle && (
                <div className="pack-backdrop" role="dialog" aria-modal="true" aria-label="Packaging">
                    <div className="pack-card">
                        {step === "join" ? (
                            <>
                                <h2>Packaging now</h2>
                                {others === null ? (
                                    <p className="pack-note">Looking for open packaging sessions...</p>
                                ) : (
                                    <ul className="pack-list">
                                        {others.map((o) => (
                                            <li key={o.packId}>
                                                <span className="pack-who">
                                                    {o.who} is packaging <b>{o.job}</b> ({o.pns.length} harness
                                                    {o.pns.length === 1 ? "" : "es"}) {where(o.station)} since {sinceText(o.since)}
                                                </span>
                                                <button type="button" onClick={() => void beginPick(o)}>
                                                    Pack the same here
                                                </button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                <div className="pack-buttons">
                                    <button type="button" className="pack-go" onClick={() => void beginPick(null)}>
                                        Start a new one
                                    </button>
                                    <button type="button" className="pack-cancel" onClick={() => setOpen(false)}>
                                        Cancel
                                    </button>
                                </div>
                            </>
                        ) : (
                            <>
                                <h2>Packaging{target ? ` - ${target.job}` : ""}</h2>
                                {rows === null ? (
                                    <p className="pack-note">Loading the job's harnesses...</p>
                                ) : !target ? (
                                    <p className="pack-note">Pick the job first.</p>
                                ) : !rows.length ? (
                                    <p className="pack-note">This job has not been released to the timer yet.</p>
                                ) : (
                                    <>
                                        <p className="pack-note">
                                            Checked: every harness not fully shipped. Uncheck what you are not packaging and
                                            set how many.
                                        </p>
                                        <ul className="pack-list pack-rows">
                                            {rows.map((r, i) => (
                                                <li key={r.pn}>
                                                    <label>
                                                        <input
                                                            type="checkbox"
                                                            checked={r.on}
                                                            onChange={(e) => setRow(i, { on: e.target.checked })}
                                                        />
                                                        <span className="pack-pn">{r.pn}</span>
                                                        {r.owed > 0 && (
                                                            <span className="pack-ship">
                                                                {r.shipped} of {r.owed} shipped
                                                            </span>
                                                        )}
                                                    </label>
                                                    <span className="pack-qty">
                                                        <button type="button" onClick={() => setRow(i, { qty: r.qty - 1 })}>
                                                            -
                                                        </button>
                                                        <input
                                                            type="number"
                                                            min={0}
                                                            max={500}
                                                            value={r.qty}
                                                            onChange={(e) => setRow(i, { qty: Number(e.target.value) })}
                                                        />
                                                        <button type="button" onClick={() => setRow(i, { qty: r.qty + 1 })}>
                                                            +
                                                        </button>
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                                <div className="pack-buttons">
                                    {target && rows && rows.length > 0 && (
                                        <button type="button" className="pack-go" onClick={done}>
                                            Done - {units(rows.filter((r) => r.on))} units
                                        </button>
                                    )}
                                    {!target && (
                                        <button
                                            type="button"
                                            className="pack-go"
                                            onClick={() => {
                                                setOpen(false);
                                                nav("/choose-kit");
                                            }}
                                        >
                                            Choose a job
                                        </button>
                                    )}
                                    <button type="button" className="pack-cancel" onClick={() => setOpen(false)}>
                                        Cancel
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

export default PackagingSession;
