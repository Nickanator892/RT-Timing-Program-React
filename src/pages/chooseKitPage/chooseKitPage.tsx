import "./chooseKitPage.css";
import { Fragment, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useBuildKit } from "../../hooks/useBuildKit";
import { useSharedState } from "../../hooks/useSharedState";
import { useJobs, jobIsComplete, jobAllBuilt, type Job } from "../../hooks/useJobs";
import RTLogo from "../../components/RTLogo/RTLogo";
import BackButton from "../../common/buttons/backButton/backButton";
import { requestGuardedChange } from "../../common/carryoverLock/carryoverLock";

/**
 * Pick the job to work on.
 *
 * Deliberately the same shape as the RtMcs schedule page - sequence number, job
 * name, customer / rev / harness count underneath, chips on the right, dates on
 * the end - because it IS the same schedule. The bench and the office should be
 * looking at a card that reads the same and is called the same thing, instead of
 * the operator translating "rev 5450" into "the Schellvac constant kit".
 *
 * Finished jobs ghost the way they do on the board (Randy, 2026-10-07): a job
 * whose every unit has shipped - the board's own test, asked of RT-MCS - leaves
 * the live list and comes after it, dimmed, under a "Completed" divider, in the
 * same pages. It stays tappable: a late unit or a rework still has to be
 * findable, just not in the way. A job that is only ALL BUILT stays live - it
 * may still have Braid, Overmold or Final Test to time.
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
    const allBuilt = jobAllBuilt(job);
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
                    {/* Shipped is the board's word and wins: a unit built off the timer still
                        shipped, so "2 to go" on a finished job would be wrong. */}
                    {done ? " · all shipped" : allBuilt ? " · all built" : ` · ${remaining} to go`}
                </span>
            </span>

            <span className="job-chips">
                {job.unitsRunning > 0 && (
                    <span className="chip c-run">IN PROGRESS · {job.unitsRunning}</span>
                )}
                {job.shortLines > 0 && <span className="chip c-short">SHORT · {job.shortLines}</span>}
                {job.inStock > 0 && <span className="chip c-stock">IN STOCK · {job.inStock}</span>}
                {done && <span className="chip c-ready">SHIPPED</span>}
                {!done && allBuilt && <span className="chip c-ready">ALL BUILT</span>}
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
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState("");

    const { active, completed } = useMemo(() => {
        const a: Job[] = [];
        const c: Job[] = [];
        for (const j of jobs ?? []) (jobIsComplete(j) ? c : a).push(j);
        return { active: a, completed: c };
    }, [jobs]);

    // Live jobs first, then the finished ones - one list, paged together, like
    // the board's running list with its Completed block underneath.
    const ordered = useMemo(() => [...active, ...completed], [active, completed]);
    const start = page * JOBS_PER_PAGE;
    const shown = ordered.slice(start, start + JOBS_PER_PAGE);
    const hasNext = ordered.length > start + JOBS_PER_PAGE;
    // The divider sits above the first finished job on every page that has one.
    const firstDone = shown.findIndex(jobIsComplete);

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
            // finding [4]: harness selection has App.tsx's setHarn wrapper as
            // a backstop on the actual mutation "regardless of how the
            // operator got to this route" - job/kit selection had no
            // equivalent. chooseKitButton guards the NAVIGATION to
            // /choose-kit, but loginPage.tsx's afterLogin() and
            // recoveryPage.tsx's notNow()/no-candidate fallback both land
            // here with no guard at all, so this page's own mutation is where
            // it has to be gated - regardless of entry route, same as harness.
            requestGuardedChange("job", () => setSelectedJob(job));
            nav("/choose-harn");
        } catch (e: any) {
            setErr(String(e?.message ?? e));
            setBusy(false);
        }
    }

    return (
        <div className="job-page">
            <BackButton />
            <h2 className="job-header">Select Job</h2>

            {loading && <p className="job-empty">Loading the schedule...</p>}
            {!loading && active.length === 0 && completed.length === 0 && (
                <p className="job-empty">
                    Nothing on the build schedule. Publish a run from HPP: Build Schedule → Timing
                    Program Runs → Publish.
                </p>
            )}
            {!loading && active.length === 0 && completed.length > 0 && (
                <p className="job-empty">Every scheduled job has shipped.</p>
            )}

            <div className="job-list">
                {shown.map((job, i) => (
                    <Fragment key={job.msid}>
                        {i === firstDone && (
                            <h3 className="job-completed-head">
                                Completed · {completed.length} Job{completed.length === 1 ? "" : "s"} Fully Shipped
                            </h3>
                        )}
                        <JobCard job={job} onChoose={choose} busy={busy} />
                    </Fragment>
                ))}
            </div>

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
