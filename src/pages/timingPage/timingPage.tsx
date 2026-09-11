import "./timingPage.css";
import { useState, useEffect, useRef, useCallback } from "react";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import useTimes, { type LoggedTime } from "../../hooks/useTimes";
import { useBuildKit } from "../../hooks/useBuildKit";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";
import TimerModeDropdown from "../../common/timerModeDropdown/timerModeDropdown";
import SecondOperator from "../../common/secondOperator/secondOperator";
import PrimaryOperator from "../../common/primaryOperator/primaryOperator";
import TimeSetupButton from "../../common/buttons/timeSetupButton/timeSetupButton";
import TimeTeardownButton from "../../common/buttons/timeTeardownButton/timeTeardownButton";
import TimeBuildButton from "../../common/buttons/timeBuildButton/timeBuildButton";
import type { PauseReason } from "../../assets/types/pauseReasonType";
import type { User } from "../../assets/types/UserType";
import { useSyncedTimer } from "../../hooks/useSyncedTimer";
import CloseButton from "../../common/buttons/closeButton/closeButton";
import RTLogo from "../../components/RTLogo/RTLogo";
import { writeDistributedTimes, parseTimestamp } from "../../assets/timeDistribution";

/** Must match the seeded reason name in the backend migration. */
const CLOCKED_OUT_REASON = "Clocked out (QuickBooks)";

type timingPageProps = {
    activeButton: "start" | "pause" | "end" | "submit" | null;
    setActiveButton: (value: "start" | "pause" | "end" | "submit" | null) => void;
    err: string;
    setErr: (value: string) => void;
    pauseStart: string | null;
    setPauseStart: React.Dispatch<React.SetStateAction<string | null>>;
};

function TimingPage({
    activeButton,
    setActiveButton,
    err,
    setErr,
    pauseStart,
    setPauseStart,
}: timingPageProps) {
    const { buildKit } = useBuildKit();
    const [dbSuccess, setDbSuccess] = useState("Submit");
    const [harnBuilt, setHarnBuilt] = useState(0);
    const [harnTotal, setHarnTotal] = useState(0);
    const [isRunning, setIsRunning] = useSharedState<boolean>("isRunning", false);
    const [timerDone, setTimerDone, timerDoneLoaded] = useSharedState<boolean>("timerDone", true);
    // Set by the main process when heartbeats stop landing: the clock is
    // counting but nothing is being written.
    const [heartbeatError] = useSharedState<string | null>("heartbeatError", null);
    const displayTimer = useSyncedTimer();
    const [startTime, setStartTime] = useSharedState<string>("startTime", "");
    const [endTime, setEndTime] = useSharedState<string>("endTime", "");
    const [selectedHarn, , selectedHarnLoaded] = useSharedState<string>("selectedHarn", "");
    const [disableButtons, setDisabledButtons] = useState<boolean>(false);
    const [disableSubmit, setDisableSubmit] = useState<boolean>(true);
    const [refreshTrigger, setRefreshTrigger] = useSharedState<number>("refreshTrigger", 0);
    const [currentBuildId, setCurrentBuildId] = useSharedState<number | boolean>(
        "currentBuildId",
        0
    );
    const [selectedUser, _setSelectedUser, selectedUserLoaded] = useSharedState<User | undefined>(
        "selectedUser",
        undefined
    );
    const [sharedPauseReason, _setSharedPauseReason] = useSharedState<PauseReason | undefined>(
        "pauseReason",
        undefined
    );
    const [secondaryBuilders, setSecondaryBuilders, crewLoaded] = useSharedState<{Id: Number, name: string}[]>("secondaryBuilders", [])
    const [timerMode, _setTimerMode, timerModeLoaded] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    const [currentSegmentStart, setCurrentSegmentStart] = useSharedState<string>("currentSegmentStart", "");
    // The segment rows are what carry the time; targeting them by id (rather
    // than by "whichever one is open") is what makes recovery and multi-segment
    // builds safe to close.
    const [currentSegmentId, setCurrentSegmentId] = useSharedState<number>("currentSegmentId", 0);
    // Batch mode: one timed window covers `batchUnits` physical units of the PN
    // (e.g. stripping every cable for all harnesses at once). No rows are
    // written at start - submit slices the window across the units.
    //
    // Shared state, not page state: this page unmounts on every trip to the
    // pause-reason screen, and on 2026-09-09 a batch Final Test came back from
    // one with the flag silently off - the crew-change roll and the Submit then
    // both aimed at the previous build's closed segment and nothing was written.
    const [batchMode, setBatchMode] = useSharedState<boolean>("batchMode", false);
    const [batchUnits, setBatchUnits] = useSharedState<number>("batchUnits", 1);
    const [batchPauses, setBatchPauses] = useSharedState<{ start: string; end: string; reasonId: string | undefined }[]>(
        "batchPauses",
        []
    );
    const { writeTime, fetchTimes } = useTimes();
    const nav = useNavigate();

    // Randy's rule (2026-09-09): every timing operation other than Build defaults
    // to batch - setup, teardown, final test and the rest are normally done for
    // every unit at once, a Build is one harness. Applied when the MODE changes
    // (and once when the page first sees it), only while idle, so a deliberate
    // un-tick survives until the next mode change, and a mode change mid-run
    // cannot flip a timer that already has rows.
    const batchDefaultedForMode = useRef<number | null>(null);
    useEffect(() => {
        if (!timerModeLoaded || !timerDoneLoaded) return;
        if (batchDefaultedForMode.current === timerMode.id) return;
        batchDefaultedForMode.current = timerMode.id;
        if (timerDone) setBatchMode(timerMode.id !== 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timerMode.id, timerModeLoaded, timerDoneLoaded, timerDone]);

    const timesFetched = useRef(false);
    const lastSelectedHarn = useRef("");

    // --- Crew change: roll the live segment ---------------------------------
    // Shared state is not a clean event stream. Every broadcast from the main
    // process (each timer tick included) rewrites every key with main's snapshot
    // at send time, so for a few milliseconds after any local change the page
    // renders OLD values again - old roster, old timerDone, old segment ids.
    // Deciding on the render in which something changed is what produced
    // phantom rolls against segments that were already closed, and the roster
    // itself arrives a moment after mount as a placeholder-to-real transition
    // (this page remounts on every trip to the pause-reason screen). So: on any
    // change, wait for the values to settle, then decide from the LATEST ones.
    //
    // The primary builder is watched here too, not in an effect of its own: a
    // handover to whoever was the second operator changes BOTH at once, and two
    // effects would race to roll the same segment. One settle window coalesces
    // them into a single roll.
    const primaryId = Number(selectedUser?.Id ?? 0);
    const latest = useRef({ secondaryBuilders, primaryId, timerDone, batchMode, isRunning, currentBuildId, currentSegmentId });
    latest.current = { secondaryBuilders, primaryId, timerDone, batchMode, isRunning, currentBuildId, currentSegmentId };
    const isFirstRender = useRef(true);
    const prevSecondaryBuilders = useRef(secondaryBuilders);
    const prevPrimaryId = useRef(primaryId);
    const crewCheck = useRef<number | null>(null);
    const rolling = useRef(false);
    const CREW_SETTLE_MS = 400;

    // handleBuilderChange - close the live segment and open its replacement in
    // ONE transaction. Between those two writes the build has no open segment,
    // and RtMcs's timer sweep reads that as a finished build and proposes
    // consuming inventory for it.
    //
    // The clock is left exactly as it was found. This used to pause and then
    // unconditionally restart it, so a crew change made during a pause set the
    // build running again with Pause still lit (2026-09-09).
    async function handleBuilderChange(L: typeof latest.current, handover: boolean) {
        if (!L.currentBuildId || !L.currentSegmentId) {
            setErr(
                handover
                    ? "This timer has no open segment on record, so the handover is not saved yet. " +
                          "The builder on screen is the one this time will be recorded against."
                    : "This timer has no open segment on record, so the crew change is not saved yet. " +
                          "Both operators will be recorded when this time is submitted."
            );
            return;
        }

        const wasRunning = L.isRunning;
        if (wasRunning) {
            window.electron.timerPause();
            setIsRunning(false);
        }

        rolling.current = true;
        try {
            const rolled = await postApi("/api/build/segment-roll", {
                buildId: L.currentBuildId,
                segmentId: L.currentSegmentId,
                accumSeconds: await window.electron.getSegmentSeconds(),
                numberOfBuilders: L.secondaryBuilders.length + 1,
                secondaryBuilderIds: L.secondaryBuilders.map((b) => Number(b.Id)),
                // Only on a handover. Sent on every roll it would be harmless
                // today, but it is the one field that rewrites who owns the
                // build, so it travels only when that is what happened.
                builderId: handover ? L.primaryId : undefined,
            });
            setCurrentSegmentStart(rolled.startTime);
            setCurrentSegmentId(rolled.segmentId);
            window.electron.timerSegment({ segmentId: rolled.segmentId, segmentAccumSeconds: 0 });
        } catch (e: any) {
            setErr(
                `Could not record the ${handover ? "handover" : "builder change"}: ${e?.message ?? e}`
            );
        } finally {
            rolling.current = false;
            if (wasRunning) {
                window.electron.timerStart();
                setIsRunning(true);
            }
        }
    }

    useEffect(() => {
        // selectedUserLoaded as well as crewLoaded: the logged-in builder
        // arrives over IPC a moment after mount, and the undefined placeholder
        // before it would read as a handover away from nobody.
        if (!crewLoaded || !selectedUserLoaded) return;
        if (crewCheck.current) window.clearTimeout(crewCheck.current);
        crewCheck.current = window.setTimeout(function check() {
            crewCheck.current = null;
            const L = latest.current;
            const crew = (list: { Id: Number; name: string }[]) =>
                list.map((b) => Number(b.Id)).sort((a, b) => a - b).join(",");
            const track = () => {
                prevSecondaryBuilders.current = L.secondaryBuilders;
                prevPrimaryId.current = L.primaryId;
            };

            if (isFirstRender.current) {
                isFirstRender.current = false;
                track();
                return;
            }
            // Idle: nothing to roll, but keep following the roster. Otherwise
            // the release at Submit is never seen, and the next Start on this
            // same page reads the stale roster as a crew change. The same goes
            // for the primary - logging in as someone else between builds is
            // not a handover.
            if (L.timerDone) {
                track();
                return;
            }
            // Compared by identity, not by count: swapping one second operator
            // for another is still a crew change, and a count check would miss
            // it and bill the rest of the segment to the person who left.
            const crewChanged = crew(L.secondaryBuilders) !== crew(prevSecondaryBuilders.current);
            // A handover to whoever was the second operator drops them from the
            // roster in the same breath, so both of these fire at once and the
            // roll below records the new pairing and the new owner together.
            const handover = L.primaryId > 0 && L.primaryId !== prevPrimaryId.current;
            if (!crewChanged && !handover) return;
            if (rolling.current) {
                crewCheck.current = window.setTimeout(check, CREW_SETTLE_MS);
                return;
            }
            // Marked as handled before the attempt, success or not: a failed
            // roll is reported once, not retried on every later render.
            track();

            // Batch runs have no rows to segment yet - the final builder count,
            // and the builder it is recorded against, come from the page when
            // submit writes the distributed rows.
            if (L.batchMode) return;
            void handleBuilderChange(L, handover);
        }, CREW_SETTLE_MS);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [crewLoaded, selectedUserLoaded, secondaryBuilders, primaryId, currentBuildId, currentSegmentId, timerDone, batchMode, isRunning]);

    useEffect(() => () => { if (crewCheck.current) window.clearTimeout(crewCheck.current); }, []);

    // Default the batch unit count to the PN's qty-to-build.
    useEffect(() => {
        const harness = buildKit?.harnesses.find((h) => h.partNum === selectedHarn);
        if (harness && harness.buildNumber > 0) setBatchUnits(harness.buildNumber);
    }, [selectedHarn, buildKit]);

    useEffect(() => {
        if (selectedHarn !== lastSelectedHarn.current) {
            timesFetched.current = false;
            lastSelectedHarn.current = selectedHarn;
        }
    }, [selectedHarn]);

    useEffect(() => {
        if (!selectedHarn || timesFetched.current) return;
        timesFetched.current = true;
        async function loadBuiltCount() {
            const result = await fetchTimes(selectedHarn, timerMode.id);
            if (buildKit) {
                const harness = buildKit.harnesses.find((h) => h.partNum === selectedHarn);
                if (harness) setHarnTotal(harness.buildNumber);
            }
            if (Array.isArray(result)) {
                setHarnBuilt(result.length);
            }
        }
        loadBuiltCount();
    }, [selectedHarn, buildKit]);

    // Refresh counts when a time is submitted
    useEffect(() => {
        timesFetched.current = false;
    }, [refreshTrigger]);

    const execQuery = async (requestedQuery: string, params: unknown[] = []): Promise<any> => {
        try {
            const response = await fetch("http://localhost:5000/api/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: requestedQuery, params }),
            });
            const data = await response.json();

            if (data.success === false) return false;
            return data;
        } catch (err: any) {
            console.log(err);
            return false;
        }
    };

    /** Transactional endpoints (build start / segment roll). Throws on failure
     *  so a half-written build can never be mistaken for a started one. */
    const postApi = async (route: string, body: unknown): Promise<any> => {
        const response = await fetch(`http://localhost:5000${route}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!data?.success) throw new Error(data?.error || `${route} failed`);
        return data.result;
    };

    /** Writes that must not fail quietly.
     *
     *  execQuery above returns `false` for every failure and throws nothing, so
     *  an INSERT that never happened is indistinguishable from one that did.
     *  That is fine for the reads it is used for and wrong for anything that
     *  records time - use this instead, and let the caller decide what to tell
     *  the operator. The server's own message is preserved: "attempt to write a
     *  readonly database" is the sentence that explains the whole problem. */
    const execWrite = async (query: string, params: unknown[] = []): Promise<any> => {
        const response = await fetch("http://localhost:5000/api/query", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ query, params }),
        });
        const data = await response.json();
        if (!data?.success) throw new Error(data?.error || "the database rejected the write");
        return data.result;
    };

    // A build restored after a crash arrives mid-flight: it is not "done", the
    // clock already shows earned time, and Submit must be available without
    // pressing End first.
    useEffect(() => {
        if (!timerDone && !isRunning && displayTimer !== "00:00:00") setDisableSubmit(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // --- QuickBooks Time clock link -------------------------------------
    // A builder who is opted in (HARNBUILDERS.qbAutoPause) cannot be timed
    // while clocked out: a running build pauses itself, and Start is blocked
    // until they clock back in. Clocking IN never auto-resumes - being back on
    // the clock does not mean they are back on this harness.
    const CLOCK_POLL_MS = 30_000;
    const CLOCK_STALE_MS = 3 * 60_000; // poller runs every 30s; 3 min = clearly dead
    const [clockBlocked, setClockBlocked] = useState(false);
    const autoPausedRef = useRef(false);

    useEffect(() => {
        if (!selectedUser?.Id) return;
        let cancelled = false;

        async function checkClock() {
            const data = await execQuery(
                `SELECT b.qbAutoPause, b.qbTimeUserId, s.onTheClock, p.lastPollAt,
                        (SELECT Id FROM HARNBUILDPAUSEREASONS WHERE reason_name = ? LIMIT 1) AS reasonId
                   FROM HARNBUILDERS b
              LEFT JOIN QBTIMESTATUS s ON s.qbTimeUserId = b.qbTimeUserId
              LEFT JOIN QBTIMEPOLL   p ON p.id = 1
                  WHERE b.Id = ?`,
                [CLOCKED_OUT_REASON, selectedUser!.Id]
            );
            if (cancelled) return;
            const row = data?.result?.[0];
            if (!row || Number(row.qbAutoPause) !== 1 || !row.qbTimeUserId) {
                setClockBlocked(false);
                return;
            }

            // If the poller has stopped, clock state is unknown. Unknown must
            // never read as "clocked out" - that would pause the whole floor
            // the moment the poller or the network hiccups.
            const polled = parseTimestamp(row.lastPollAt);
            if (!polled || Date.now() - polled.getTime() > CLOCK_STALE_MS) {
                setClockBlocked(false);
                return;
            }

            const offTheClock = Number(row.onTheClock) === 0;
            setClockBlocked(offTheClock);

            if (offTheClock && isRunning && !timerDone && !autoPausedRef.current) {
                autoPausedRef.current = true;
                window.electron.timerPause();
                setIsRunning(false);
                setPauseStart(formatTimestamp(new Date().toISOString()));
                setEndTime(formatTimestamp(new Date().toISOString()));
                // Preset the reason so the existing resume path writes a proper
                // pause row without sending the operator to the reason screen.
                if (row.reasonId) {
                    window.electron.updateSharedData({
                        pauseReason: { Id: String(row.reasonId), name: CLOCKED_OUT_REASON },
                    });
                }
                setErr(`${selectedUser!.name} clocked out of QuickBooks - timer paused`);
            }
            if (!offTheClock) autoPausedRef.current = false;
        }

        checkClock();
        const id = window.setInterval(checkClock, CLOCK_POLL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedUser?.Id, isRunning, timerDone]);

    // --- Second operator: back to one crew member, on its own ------------
    // Two people on one harness record double time, and the expensive failure
    // is forgetting to drop the pairing: every later harness then bills twice
    // the labour, silently, until someone questions the numbers. So the pairing
    // is released whenever the operation that justified it is over - a
    // submitted time, a different harness, or the shift ending - and NEVER
    // mid-run, which would under-record work two people are actually doing.
    const releaseSecondOperator = useCallback(
        (why: string) => {
            setSecondaryBuilders((prev) => {
                if (prev.length === 0) return prev;
                console.log(`Second operator released: ${why}`);
                return [];
            });
        },
        [setSecondaryBuilders]
    );

    // Shift end. The same clock-out that pauses the timer ends the pairing:
    // whoever was helping is not on the clock either.
    useEffect(() => {
        if (clockBlocked) releaseSecondOperator("clocked out of QuickBooks");
    }, [clockBlocked, releaseSecondOperator]);

    // A different harness PN is a different operation. Only while idle - a
    // harness cannot change mid-run, and rolling a segment here would be wrong.
    //
    // Not before the shared values have arrived: this page remounts on every
    // trip to the pause-reason screen, and the placeholder timerDone (true)
    // seen on that first render released the second operator mid-build, every
    // time, with the segment still recorded as two people (2026-09-09).
    useEffect(() => {
        if (!timerDoneLoaded || !selectedHarnLoaded) return;
        if (timerDone) releaseSecondOperator("harness changed");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedHarn, timerDoneLoaded, selectedHarnLoaded]);

    // --- Database writability -------------------------------------------
    // A read-only share is invisible until something tries to write: the app
    // starts, the builder list loads, the clock counts up, and every INSERT
    // fails. After a power cut the Pi is routinely up before the file server,
    // which is how a build came to be started against a read-only database on
    // 2026-08-31. Start is blocked until the database can actually take a write
    // - but only on a definite "no". An unreachable status endpoint is unknown,
    // not bad, and unknown must never stop the floor from working.
    const DB_POLL_MS = 30_000;
    const [dbBlocked, setDbBlocked] = useState(false);

    /** null when the database is writable (or unknown); otherwise the reason. */
    const checkDbWritable = async (): Promise<string | null> => {
        try {
            const response = await fetch("http://localhost:5000/api/db-status");
            const data = await response.json();
            if (data?.writable === false) {
                const why = String(data?.writeError || data?.error || "the share is read-only");
                setDbBlocked(true);
                return why;
            }
            setDbBlocked(false);
            return null;
        } catch {
            setDbBlocked(false);
            return null;
        }
    };

    useEffect(() => {
        checkDbWritable();
        const id = window.setInterval(checkDbWritable, DB_POLL_MS);
        return () => window.clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /** The pause row is what keeps the paused window OUT of this build's time.
     *  If it is not written, that window is silently charged to the build - so
     *  this throws with the real reason and the caller refuses to resume. */
    async function insertPause() {
        const pauseEnd = formatTimestamp(new Date().toISOString());
        if (!sharedPauseReason) return;
        await execWrite(
            "INSERT INTO HARNBUILDTIMES (buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
            [currentBuildId, pauseStart, pauseEnd, selectedHarn, buildKit?.REV, selectedUser?.Id, 4, sharedPauseReason.Id]
        );
    }

    // Local time in "YYYY-MM-DD HH:mm:ss": sorts correctly as text (ORDER BY
    // startTime) and parses with new Date() (the old dd/mm/yyyy-HH:mm:ss did
    // neither - analytics durations came back NaN).
    function formatTimestamp(iso: string): string {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const HH = String(d.getHours()).padStart(2, '0');
    const MM = String(d.getMinutes()).padStart(2, '0');
    const SS = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`;
    }

    async function startTimer() {
        if (isRunning) return;
        if (clockBlocked) {
            setErr(`${selectedUser?.name ?? "This builder"} is clocked out of QuickBooks - clock in to start timing`);
            return;
        }
        // Checked at the moment of the press, not just on the 30s poll: the
        // window this exists for is the few minutes after a power cut, when it
        // flips from read-only to writable.
        const notWritable = await checkDbWritable();
        if (notWritable) {
            // handleButtonClick has already lit Start green. Put the indicator
            // back where the timer actually is.
            setActiveButton(pauseStart ? "pause" : null);
            setErr(`Database is not writable - nothing would be recorded (${notWritable})`);
            return;
        }
        window.electron.timerStart();
        if (pauseStart) {
            // Decided by whether rows exist, not by the Batch box: the box can be
            // ticked or cleared mid-run now, so a build that started as a single
            // keeps writing its pause rows, and a batch that turns single keeps
            // queueing until Submit creates its build.
            if (!currentBuildId && !timerDone) {
                // No build row exists yet - queue the pause; submit attaches it
                // to the build row(s) it creates.
                const queued = {
                    start: pauseStart,
                    end: formatTimestamp(new Date().toISOString()),
                    reasonId: sharedPauseReason?.Id,
                };
                setBatchPauses((prev) => [...prev, queued]);
                setPauseStart(null);
            } else {
                try {
                    await insertPause();
                    // Consumed: it is on record now. Left set, a later batch
                    // Submit counted it a second time as "never resumed".
                    setPauseStart(null);
                } catch (e: any) {
                    // Without this row the paused window is charged to the build
                    // as worked time. Refuse the resume rather than quietly
                    // inflating someone's build: undo the clock we just started
                    // and leave the operator paused, exactly where they were.
                    window.electron.timerPause();
                    setIsRunning(false);
                    setActiveButton("pause");
                    setErr(`Could not record the pause: ${e?.message ?? e}`);
                    return;
                }
            }
        }

        if (timerDone) {
            const startTime = formatTimestamp(new Date().toISOString());
            setStartTime(startTime);
            setCurrentSegmentStart(startTime);
            setTimerDone(false);
            setIsRunning(true);
            setErr("");
            setDbSuccess("Submit");

            // The pause queue is emptied at EVERY start rather than only on a
            // successful submit: a run that was abandoned, or whose submit
            // failed, would otherwise hand its pauses to whatever ran next.
            setBatchPauses([]);
            // Batch runs write nothing at start - all rows are created at
            // submit, when the total window and unit count are known.
            if (batchMode) return;

            // One transaction: a crash between these inserts used to leave a
            // build row with no segment, which carries no time and is invisible
            // to the recovery scan.
            try {
                const created = await postApi("/api/build/start", {
                    harnNumber: selectedHarn,
                    rev: buildKit?.REV,
                    builderId: selectedUser?.Id,
                    timeTypeId: timerMode.id,
                    numberOfBuilders: secondaryBuilders.length + 1,
                    secondaryBuilderIds: secondaryBuilders.map((b) => Number(b.Id)),
                    startTime,
                });
                setCurrentBuildId(created.buildId);
                setCurrentSegmentId(created.segmentId);
                // Point the heartbeat at the new segment.
                window.electron.timerSegment({ segmentId: created.segmentId, segmentAccumSeconds: 0 });
            } catch (e: any) {
                // Fail loudly: previously every write error here was swallowed
                // and the operator timed a build that was never recorded.
                window.electron.timerPause();
                setIsRunning(false);
                setTimerDone(true);
                setActiveButton(null);
                setErr(`Could not start the build: ${e?.message ?? e}`);
            }
            return;
        }
        setIsRunning(true);
        setErr("");
        setDbSuccess("Submit");
    }

    function pauseTimer() {
        window.electron.timerPause();
        const pauseStartTime = formatTimestamp(new Date().toISOString())
        setPauseStart(pauseStartTime);
        // Local "YYYY-MM-DD HH:mm:ss" like every other timestamp. This was the
        // one writer still emitting an ISO/UTC string, and a Submit straight
        // from a pause (Submit is enabled again when the pause-reason page
        // returns here) wrote that UTC instant into HARNBUILDSEGMENTS.endTime -
        // hours off the local stamps around it, and unparseable to the server's
        // parseLocalStamp.
        setEndTime(formatTimestamp(new Date().toISOString()));
        setIsRunning(false);
        setTimeout(() => {
            nav("/pause-reason-page");
        }, 50);
    }

    function resetTimer() {
        if (displayTimer === "00:00:00") return;
        window.electron.timerPause();
        if (!timerDone) {
            const localEndTime = formatTimestamp(new Date().toISOString())
            setEndTime(localEndTime);
        }
        setIsRunning(false);
        setDisableSubmit(false);
    }

    /** Batch submit: slice the timed window across the unit count. */
    async function submitBatch() {
        const units = Math.max(1, Math.floor(batchUnits));
        setDbSuccess("Saving batch...");
        try {
            const startMs = new Date(startTime).getTime();
            const endMs = new Date(endTime).getTime();
            if (isNaN(startMs) || isNaN(endMs) || endMs <= startMs) {
                throw new Error("Bad time window - end the timer before submitting");
            }

            // A pause that was never resumed - pause, End, Submit - is still
            // open and was never queued, because queuing happens on Resume.
            // Without this the break sits inside the window with nothing to
            // show for it.
            const pauses = [...batchPauses];
            if (pauseStart) {
                pauses.push({
                    start: pauseStart,
                    end: endTime,
                    reasonId: sharedPauseReason?.Id,
                });
            }

            // Started as a single build and switched to batch mid-run: that
            // build already has rows (its open segment, pause rows, crew
            // segments). Take its pauses over, drop it, and let the batch write
            // its units fresh. The pauses go into the shared queue BEFORE the
            // drop, so a failed batch write below still has them for the retry.
            if (currentBuildId) {
                const dropped = await postApi("/api/build/discard", { buildId: currentBuildId });
                const carried = (dropped?.pauses ?? []).map((p: any) => ({
                    start: String(p.startTime ?? ""),
                    end: String(p.endTime ?? ""),
                    reasonId: p.pauseReasonId == null ? undefined : String(p.pauseReasonId),
                }));
                pauses.unshift(...carried);
                setBatchPauses((prev) => [...carried, ...prev]);
                setCurrentBuildId(0);
                setCurrentSegmentId(0);
                window.electron.timerSegment({ segmentId: undefined, segmentAccumSeconds: 0 });
            }

            // A batch's duration comes from the wall clock, so unlike a normal
            // build it is NOT pause-free - start-to-end covers every break in
            // between. The main-process timer IS pause-free (it freezes on
            // pause), so take the earned total from there. Otherwise a 30-minute
            // lunch is divided up and added to every unit in the batch, and the
            // total no longer matches the clock the operator was watching.
            const shared = await window.electron.getSharedData();
            const elapsedMs = Number(shared?.elapsedTime ?? 0);
            const windowMs = endMs - startMs;
            const workedMs = elapsedMs > 0 ? Math.min(elapsedMs, windowMs) : windowMs;

            const buildIds = await writeDistributedTimes({
                harnNumber: selectedHarn,
                rev: buildKit?.REV,
                builderId: selectedUser?.Id,
                timeTypeId: timerMode.id,
                units,
                startMs,
                endMs,
                workedMs,
                numberOfBuilders: secondaryBuilders.length + 1,
                secondaryBuilderIds: secondaryBuilders.map((b) => Number(b.Id)),
            });
            // execWrite, not execQuery: a dropped pause row here would silently
            // inflate the batch's times, and submitBatch's catch reports it.
            for (const pause of pauses) {
                await execWrite(
                    "INSERT INTO HARNBUILDTIMES (buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                    [buildIds[0], pause.start, pause.end, selectedHarn, buildKit?.REV, selectedUser?.Id, 4, pause.reasonId]
                );
            }
            setBatchPauses([]);

            const updatedTimes = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }
            window.electron.timerReset();
            setCurrentBuildId(0);
            setCurrentSegmentId(0);
            setRefreshTrigger((prev) => prev + 1);
            setTimerDone(true);
            setDbSuccess(`${units} units ✅`);
            setErr("");
            setPauseStart(null);
            // Same rule as a single submit: the pairing ends with the operation.
            releaseSecondOperator("batch submitted");
        } catch (e: any) {
            setErr(String(e?.message ?? e));
            setDbSuccess("Submit");
        }
    }

    /** Record the time on screen as a build of its own: the build row, its
     *  time row and ONE closed segment carrying the pause-free elapsed seconds
     *  from the main-process clock. Used when Submit finds no open segment to
     *  close, so the operator's time is written instead of abandoned. */
    async function recordAsNewBuild() {
        const shared = await window.electron.getSharedData();
        const elapsedSeconds = Math.max(1, Math.round(Number(shared?.elapsedTime ?? 0) / 1000));
        const end = endTime || formatTimestamp(new Date().toISOString());
        const start =
            startTime ||
            formatTimestamp(new Date(new Date(end).getTime() - elapsedSeconds * 1000).toISOString());
        setDbSuccess("Recording...");
        const created = await postApi("/api/build/start", {
            harnNumber: selectedHarn,
            rev: buildKit?.REV,
            builderId: selectedUser?.Id,
            timeTypeId: timerMode.id,
            numberOfBuilders: secondaryBuilders.length + 1,
            secondaryBuilderIds: secondaryBuilders.map((b) => Number(b.Id)),
            startTime: start,
        });
        await execWrite(
            `UPDATE HARNBUILDSEGMENTS
                SET endTime = ?, accumSeconds = ?, heartbeatAt = ?, heartbeatState = 'PAUSE'
              WHERE segmentId = ? AND COALESCE(endTime, '') = ''`,
            [end, elapsedSeconds, end, created.segmentId]
        );
        // Pauses taken while there was no build row to hang them on (a batch
        // that turned single mid-run, or the pause that was never resumed).
        const pauses = [...batchPauses];
        if (pauseStart) pauses.push({ start: pauseStart, end, reasonId: sharedPauseReason?.Id });
        for (const pause of pauses) {
            await execWrite(
                "INSERT INTO HARNBUILDTIMES (buildId, startTime, endTime, harnNumber, REV, builderId, timeTypeId, pauseReasonId) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                [created.buildId, pause.start, pause.end, selectedHarn, buildKit?.REV, selectedUser?.Id, 4, pause.reasonId]
            );
        }
        setBatchPauses([]);
    }

    async function submitTime() {
        setDbSuccess("Checking...");
        if (isRunning) {
            setErr("Timer is still running");
            setDbSuccess("Submit");
            return;
        }
        const currentTime = displayTimer;
        if (currentTime === "00:00:00") {
            setErr("Timer is 00:00:00");
            setDbSuccess("Submit");
            return;
        }
        if (batchMode) {
            await submitBatch();
            return;
        }
        setDbSuccess("Fetching...");
        try {
            const timeObject: Partial<LoggedTime> = {
                startTime: startTime,
                endTime: endTime,
                harnNumber: selectedHarn,
            };
            // Close the segment this timer has been heartbeating. When there is
            // none on record, or the one on record is already closed, the time
            // on screen is still real work: record it as a build of its own.
            // This used to return silently with the button stuck on
            // "Fetching..." and nothing written (2026-09-09: a 28-minute Final
            // Test whose ids still pointed at the previous, submitted build).
            let closed: unknown = "nomatch";
            if (typeof currentBuildId == "number" && currentBuildId > 0 && currentSegmentId > 0) {
                closed = await writeTime(timeObject, currentBuildId, selectedUser?.Id);
            }
            if (closed === "nomatch") {
                await recordAsNewBuild();
            } else if (!closed) {
                throw new Error("Could not close the segment - nothing was written. Check the database and Submit again.");
            }

            const updatedTimes = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }

            window.electron.timerReset();
            // The ids belong to the build just closed. Left in place, the next
            // timer that has no build of its own would write into this one.
            setCurrentBuildId(0);
            setCurrentSegmentId(0);
            setRefreshTrigger((prev) => prev + 1); // ← triggers analytics to refresh
            setTimerDone(true);
            setDbSuccess("Success✅");
            setErr("");
            setPauseStart(null);

            // The operation is over, so the pairing is too (Randy's rule: back
            // to one at the end of any timing operation - setup, build, final
            // test, teardown). Safe here: timerDone is already true, so the
            // builder-change effect will not try to roll a segment.
            releaseSecondOperator("timing operation submitted");

            if (harnBuilt + 1 >= harnTotal) {
                setDbSuccess("ALL BUILT ✅");
            }
        } catch (e: any) {
            setErr(e);
            setDbSuccess("Submit");
        }
    }

    const handleButtonClick = (button: "start" | "pause" | "end" | "submit") => {
        setActiveButton(button);
        if (button === "start") startTimer();
        if (button === "pause") pauseTimer();
        if (button === "end") resetTimer();
        if (button === "submit") submitTime();
    };


    return (
        <div className="timing-page">
            <div id="buttons">
                <button
                    id="start-button"
                    className={activeButton === "start" ? "pressed" : ""}
                    onClick={() => handleButtonClick("start")}
                    disabled={disableButtons || clockBlocked || dbBlocked}
                >
                    {dbBlocked
                        ? "No Database"
                        : clockBlocked
                        ? "Clocked Out"
                        : isRunning
                        ? "Running"
                        : displayTimer === "00:00:00"
                        ? "Start"
                        : "Resume"}
                </button>
                <button
                    id="pause-button"
                    className={activeButton === "pause" ? "pressed" : ""}
                    onClick={() => handleButtonClick("pause")}
                    disabled={!isRunning || disableButtons}
                >
                    Pause
                </button>
                <button
                    id="end-button"
                    className={activeButton === "end" ? "pressed" : ""}
                    onClick={() => {
                        handleButtonClick("end");
                        setDisabledButtons(true);
                        setTimeout(() => {
                            setDisabledButtons(false);
                        }, 100);
                    }}
                    disabled={disableButtons}
                >
                    End
                </button>
                <hr id="colour-indicator" />
                <button
                    id="submit-time-button"
                    className={activeButton === "submit" ? "pressed" : ""}
                    onClick={() => handleButtonClick("submit")}
                    disabled={disableButtons || disableSubmit}
                >
                    {dbSuccess}
                </button>
            </div>
            <div id="error-timer">
                {/* The logo lives IN the top row rather than absolutely
                    positioned over it: as an overlay it sat on top of the
                    Harness and Job buttons on any panel narrower than about
                    1100px (Randy, 2026-09-08). space-between cannot overlap. */}
                <div id="nav-buttons">
                    <div id="nav-button-group">
                        <TimerButton />
                        <SettingsButton />
                        <ChooseHarnessButton />
                        <ChooseKitButton />
                    </div>
                    <RTLogo />
                </div>
                <p id="timer">{displayTimer}</p>

                <div className="harn-info-and-close-button">
                    <div className="harn-build-info">
                        <p id="current-build-pn">Part #: {selectedHarn}</p>
                        <p id="timer-mode">Timer Mode: {timerMode.header}</p>
                    </div>
                    <TimerModeDropdown/>
                    <PrimaryOperator />
                    <SecondOperator />
                    <div className="batch-controls">
                        <label className="batch-toggle">
                            {/* Usable mid-run (Randy, 2026-09-09): a single build
                                switched to batch is converted at Submit, a batch
                                switched to single is recorded as one build. */}
                            <input
                                type="checkbox"
                                checked={batchMode}
                                onChange={(e) => setBatchMode(e.target.checked)}
                            />
                            Batch: one time across all units
                        </label>
                        {batchMode && (
                            <label className="batch-units">
                                Units:
                                <input
                                    type="number"
                                    min={1}
                                    value={batchUnits}
                                    onChange={(e) => setBatchUnits(Number(e.target.value))}
                                />
                            </label>
                        )}
                    </div>
                    <CloseButton />
                </div>

                {dbBlocked && (
                    <p className="db-warning">
                        The database cannot be written to right now. Time started here would not be
                        recorded, so Start is held until it comes back.
                    </p>
                )}
                {heartbeatError && (
                    <p className="db-warning">
                        This time is NOT being saved - {heartbeatError}. Note where you are and get
                        someone before you keep timing.
                    </p>
                )}
                <p id="error-message">{err}</p>
            </div>
        </div>
    );
}

export default TimingPage;
