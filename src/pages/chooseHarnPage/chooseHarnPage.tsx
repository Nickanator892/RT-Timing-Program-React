import "./chooseHarnPage.css";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import useTimes from "../../hooks/useTimes";
import { useBuildKit } from "../../hooks/useBuildKit";
import { useSharedState } from "../../hooks/useSharedState";
import { fetchHarnProgress, type HarnProgress, type Job } from "../../hooks/useJobs";
import RTLogo from "../../components/RTLogo/RTLogo";

interface harnProps {
    setHarn: React.Dispatch<React.SetStateAction<string>>;
}

const HARNS_PER_PAGE = 5;

type Row = {
    partNum: string;
    total: number;
    built: number;
    running: number;
    order: number;
};

/**
 * The order of this list, in one place, because it is the point of the screen:
 *
 *   1. anything mid-run first - a harness with an open segment is what the
 *      operator is actually holding, so it is never buried on page three;
 *   2. then everything outstanding, in SCHEDULED order (PROJHARN.INBUILD) -
 *      the order the floor is meant to build them in;
 *   3. finished part numbers last - still reachable for a rework or a late
 *      unit, just not in the way of the work that remains.
 */
function sortRows(rows: Row[]): Row[] {
    const rank = (r: Row) => (r.running > 0 ? 0 : r.total > 0 && r.built >= r.total ? 2 : 1);
    return [...rows].sort((a, b) => rank(a) - rank(b) || a.order - b.order);
}

function ChooseHarnPage({ setHarn }: harnProps) {
    const nav = useNavigate();
    const { buildKit } = useBuildKit();
    const { fetchTimes } = useTimes();
    const [selectedJob] = useSharedState<Job | null>("selectedJob", null);
    const [timerMode] = useSharedState<{ header: string; id: number }>("timerMode", {
        header: "Timing Build",
        id: 1,
    });

    const [progress, setProgress] = useState<Map<string, HarnProgress> | null>(null);
    const [page, setPage] = useState(0);

    // Counts are read fresh here rather than carried on the kit: the kit is
    // shared state the timer builds from, and reloading it just to refresh a
    // number would re-broadcast it to both windows mid-build.
    useEffect(() => {
        if (!buildKit) return;
        let cancelled = false;
        fetchHarnProgress(buildKit.REV, selectedJob?.phkid ?? null).then((m) => {
            if (!cancelled) setProgress(m);
        });
        return () => {
            cancelled = true;
        };
    }, [buildKit?.REV, selectedJob?.phkid]);

    const rows = useMemo(() => {
        if (!buildKit) return [];
        // buildKit.harnesses already arrives ordered by BLDORD then INBUILD -
        // scheduled order - so the index IS the schedule position.
        const base: Row[] = buildKit.harnesses.map((h, i) => ({
            partNum: h.partNum,
            total: Number(h.buildNumber ?? 0),
            built: progress?.get(h.partNum)?.built ?? 0,
            running: progress?.get(h.partNum)?.running ?? 0,
            order: i,
        }));
        return sortRows(base);
    }, [buildKit, progress]);

    const start = page * HARNS_PER_PAGE;
    const shown = rows.slice(start, start + HARNS_PER_PAGE);
    const hasNext = rows.length > start + HARNS_PER_PAGE;
    const outstanding = rows.filter((r) => !(r.total > 0 && r.built >= r.total)).length;

    function selectHarn(partNum: string) {
        if (!buildKit?.harnesses.some((h) => h.partNum === partNum)) return;
        setHarn(partNum);
        window.electron.openAnalyticsWindow();
        fetchTimes(partNum, timerMode.id);
        setTimeout(() => nav("/timer"), 500);
    }

    return (
        <div className="harn-page">
            <div className="harn-head">
                <h2 className="harn-title">Select Harness</h2>
                {selectedJob && (
                    <p className="harn-job">
                        {selectedJob.jobName}
                        <span>
                            {outstanding} of {rows.length} part numbers still outstanding
                        </span>
                    </p>
                )}
            </div>

            <div className="harn-list">
                {shown.map((r) => {
                    const done = r.total > 0 && r.built >= r.total;
                    const pct = r.total > 0 ? Math.min(100, (r.built / r.total) * 100) : 0;
                    return (
                        <button
                            type="button"
                            key={r.partNum}
                            className={`harn-row ${done ? "harn-done" : ""} ${
                                r.running > 0 ? "harn-running" : ""
                            }`}
                            onClick={() => selectHarn(r.partNum)}
                        >
                            <span className="harn-main">
                                <span className="harn-pn">{r.partNum}</span>
                                <span className="harn-bar">
                                    <span className="harn-bar-fill" style={{ width: `${pct}%` }} />
                                </span>
                            </span>
                            <span className="harn-count">
                                <b>{r.built}</b>/{r.total}
                            </span>
                            {r.running > 0 && <span className="harn-tag tag-run">IN PROGRESS</span>}
                            {done && r.running === 0 && (
                                <span className="harn-tag tag-done">COMPLETE</span>
                            )}
                        </button>
                    );
                })}
            </div>

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

export default ChooseHarnPage;
