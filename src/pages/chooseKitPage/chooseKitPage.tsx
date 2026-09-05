import "./chooseKitPage.css";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBuildKit } from "../../hooks/useBuildKit";
import { useSharedState } from "../../hooks/useSharedState";
import { useJobs, jobIsComplete, type Job } from "../../hooks/useJobs";
import RTLogo from "../../components/RTLogo/RTLogo";

/**
 * Pick the job to work on.
 *
 * Deliberately the same shape as the RtMcs schedule page - sequence number, job
 * name, customer / rev / harness count underneath, chips on the right, dates on
 * the end - because it IS the same schedule. The bench and the office should be
 * looking at a card that reads the same and is called the same thing, instead of
 * the operator translating "rev 5450" into "the Schellvac constant kit".
 *
 * Finished jobs move into a collapsed Completed section rather than disappearing:
 * a late unit or a rework still has to be findable, just not in the way.
 */

const JOBS_PER_PAGE = 4;

function fmtDate(s: string | null): string {
    if (!s) return "";
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    return m ? `${m[2]}/${m[3]}` : s;
}

function JobCard({ job, onChoose, busy }: { job: Job; onChoose: (j: Job) => void; busy: boolean }) {
    const pct = job.unitsTotal > 0 ? Math.min(100, (job.unitsBuilt / job.unitsTotal) * 100) : 0;
    const done = jobIsComplete(job);
    const remaining = Math.max(0, job.unitsTotal - job.unitsBuilt);

    return (
        <button
            type="button"
            className={`job-card ${done ? "job-done" : ""}`}
            onClick={() => onChoose(job)}
            disabled={busy}
        >
            {/* SEQ is stored in tens so jobs can be dropped between neighbours.
                RtMcs displays SEQ/10, so we do too or the numbers disagree. */}
            <span className="job-seq">{Math.round(job.seq / 10) || "-"}</span>

            <span className="job-main">
                <span className="job-name">{job.jobName}</span>
                <span className="job-sub">
                    {[
                        job.customer,
                        job.revNum != null ? `rev ${job.revNum}` : null,
                        job.harnTotal > 0 ? `${job.harnTotal} harnesses` : null,
                    ]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
                <span className="job-bar">
                    <span className="job-bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="job-progress">
                    <b>{job.unitsBuilt}</b> of {job.unitsTotal} built
                    {done ? " · complete" : ` · ${remaining} to go`}
                </span>
            </span>

            <span className="job-chips">
                {job.unitsRunning > 0 && (
                    <span className="chip c-run">IN PROGRESS · {job.unitsRunning}</span>
                )}
                {job.shortLines > 0 && <span className="chip c-short">SHORT · {job.shortLines}</span>}
                {job.inStock > 0 && <span className="chip c-stock">IN STOCK · {job.inStock}</span>}
                {done && <span className="chip c-ready">COMPLETE</span>}
            </span>

            <span className="job-dates">
                {fmtDate(job.targStart)} → {fmtDate(job.targEnd)}
            </span>
        </button>
    );
}

function ChooseKitPage() {
    const nav = useNavigate();
    const { fetchKit } = useBuildKit();
    const { jobs, loading } = useJobs();
    const [, setSelectedJob] = useSharedState<Job | null>("selectedJob", null);

    const [page, setPage] = useState(0);
    const [showDone, setShowDone] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    const { active, completed } = useMemo(() => {
        const a: Job[] = [];
        const c: Job[] = [];
        for (const j of jobs ?? []) (jobIsComplete(j) ? c : a).push(j);
        return { active: a, completed: c };
    }, [jobs]);

    const start = page * JOBS_PER_PAGE;
    const shown = active.slice(start, start + JOBS_PER_PAGE);
    const hasNext = active.length > start + JOBS_PER_PAGE;

    async function choose(job: Job) {
        if (busy) return;
        setBusy(true);
        setErr("");
        try {
            // Loads THIS job's kit only, not the whole rev.
            const kit = await fetchKit(job.rev, job.phkid);
            if (!kit || kit.harnesses.length === 0) {
                setErr(`${job.jobName} has no harnesses published for rev ${job.revNum ?? job.rev}`);
                setBusy(false);
                return;
            }
            setSelectedJob(job);
            nav("/choose-harn");
        } catch (e: any) {
            setErr(String(e?.message ?? e));
            setBusy(false);
        }
    }

    return (
        <div className="job-page">
            <h2 className="job-header">Select Job</h2>

            {loading && <p className="job-empty">Loading the schedule...</p>}
            {!loading && active.length === 0 && completed.length === 0 && (
                <p className="job-empty">
                    Nothing on the build schedule. Publish a run from HPP: Build Schedule → Timing
                    Program Runs → Publish.
                </p>
            )}
            {!loading && active.length === 0 && completed.length > 0 && (
                <p className="job-empty">Every scheduled job is complete.</p>
            )}

            <div className="job-list">
                {shown.map((job) => (
                    <JobCard key={job.msid} job={job} onChoose={choose} busy={busy} />
                ))}
            </div>

            {completed.length > 0 && (
                <div className="job-completed">
                    <button
                        type="button"
                        className="job-completed-toggle"
                        onClick={() => setShowDone((v) => !v)}
                    >
                        {showDone ? "▾" : "▸"} Completed ({completed.length})
                    </button>
                    {showDone && (
                        <div className="job-list">
                            {completed.map((job) => (
                                <JobCard key={job.msid} job={job} onChoose={choose} busy={busy} />
                            ))}
                        </div>
                    )}
                </div>
            )}

            <p className="job-error">{err}</p>

            <div className="pagination-buttons">
                <button type="button" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>
                    Previous
                </button>
                <button type="button" onClick={() => setPage((p) => p + 1)} disabled={!hasNext}>
                    Next
                </button>
            </div>
            <RTLogo />
        </div>
    );
}

export default ChooseKitPage;
