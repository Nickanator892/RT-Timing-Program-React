import "./timingPage.css";
import { useState, useEffect, useRef } from "react";
import SettingsButton from "../../common/buttons/settingsButton/settingsButton";
import TimerButton from "../../common/buttons/timerButton/timerButton";
import { useNavigate } from "react-router-dom";
import { useSharedState } from "../../hooks/useSharedState";
import ChooseHarnessButton from "../../common/buttons/chooseHarnessButton/chooseHarnessButton";
import useTimes, { type LoggedTime } from "../../hooks/useTimes";
import { useBuildKit } from "../../hooks/useBuildKit";
import ChooseKitButton from "../../common/buttons/chooseKitButton/chooseKitButton";
import TimerModeDropdown from "../../common/timerModeDropdown/timerModeDropdown";
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
    const [timerDone, setTimerDone] = useSharedState<boolean>("timerDone", true);
    // Set by the main process when heartbeats stop landing: the clock is
    // counting but nothing is being written.
    const [heartbeatError] = useSharedState<string | null>("heartbeatError", null);
    const displayTimer = useSyncedTimer();
    const [startTime, setStartTime] = useSharedState<string>("startTime", "");
    const [endTime, setEndTime] = useSharedState<string>("endTime", "");
    const [selectedHarn] = useSharedState<string>("selectedHarn", "");
    const [disableButtons, setDisabledButtons] = useState<boolean>(false);
    const [disableSubmit, setDisableSubmit] = useState<boolean>(true);
    const [refreshTrigger, setRefreshTrigger] = useSharedState<number>("refreshTrigger", 0);
    const [currentBuildId, setCurrentBuildId] = useSharedState<number | boolean>(
        "currentBuildId",
        0
    );
    const [selectedUser, _setSelectedUser] = useSharedState<User | undefined>(
        "selectedUser",
        undefined
    );
    const [sharedPauseReason, _setSharedPauseReason] = useSharedState<PauseReason | undefined>(
        "pauseReason",
        undefined
    );
    const [secondaryBuilders, _setSecondaryBuilders] = useSharedState<{Id: Number, name: string}[]>("secondaryBuilders", [])
    const [timerMode, _setTimerMode] = useSharedState<{header: string, id: number}>("timerMode", {header: "Timing Build", id: 1})
    const [currentSegmentStart, setCurrentSegmentStart] = useSharedState<string>("currentSegmentStart", "");
    // The segment rows are what carry the time; targeting them by id (rather
    // than by "whichever one is open") is what makes recovery and multi-segment
    // builds safe to close.
    const [currentSegmentId, setCurrentSegmentId] = useSharedState<number>("currentSegmentId", 0);
    // Batch mode: one timed window covers `batchUnits` physical units of the PN
    // (e.g. stripping every cable for all harnesses at once). No rows are
    // written at start - submit slices the window across the units.
    const [batchMode, setBatchMode] = useState<boolean>(false);
    const [batchUnits, setBatchUnits] = useState<number>(1);
    const batchPauses = useRef<{ start: string; end: string; reasonId: string | undefined }[]>([]);
    const { writeTime, fetchTimes } = useTimes();
    const nav = useNavigate();

    const timesFetched = useRef(false);
    const lastSelectedHarn = useRef("");

    const isFirstRender = useRef(true);
const prevSecondaryBuilders = useRef(secondaryBuilders);

useEffect(() => {
    // Skip on first render or if timer isn't running
    if (isFirstRender.current) {
        isFirstRender.current = false;
        prevSecondaryBuilders.current = secondaryBuilders;
        return;
    }

    // Only react if builders actually changed and a build is in progress
    if (timerDone) return;
    if (secondaryBuilders.length === prevSecondaryBuilders.current.length) return;
    prevSecondaryBuilders.current = secondaryBuilders;

    // Batch runs have no rows to segment yet - the final builder count is
    // recorded when submit writes the distributed rows.
    if (batchMode) return;

    // handleBuilderChange - close the live segment and open its replacement in
    // ONE transaction. Between those two writes the build has no open segment,
    // and RtMcs's timer sweep reads that as a finished build and proposes
    // consuming inventory for it.
    async function handleBuilderChange() {
        window.electron.timerPause();
        setIsRunning(false);

        try {
            const rolled = await postApi("/api/build/segment-roll", {
                buildId: currentBuildId,
                segmentId: currentSegmentId,
                accumSeconds: await window.electron.getSegmentSeconds(),
                numberOfBuilders: secondaryBuilders.length + 1,
                secondaryBuilderIds: secondaryBuilders.map((b) => Number(b.Id)),
            });
            setCurrentSegmentStart(rolled.startTime);
            setCurrentSegmentId(rolled.segmentId);
            window.electron.timerSegment({ segmentId: rolled.segmentId, segmentAccumSeconds: 0 });
        } catch (e: any) {
            setErr(`Could not record the builder change: ${e?.message ?? e}`);
        }

        window.electron.timerStart();
        setIsRunning(true);
    }

    handleBuilderChange();
}, [secondaryBuilders, currentBuildId, currentSegmentStart, selectedHarn, buildKit, selectedUser, timerMode, timerDone, batchMode]);

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
            if (batchMode && !timerDone) {
                // No build row exists yet - queue the pause; submit attaches it
                // to the batch's first build row.
                batchPauses.current.push({
                    start: pauseStart,
                    end: formatTimestamp(new Date().toISOString()),
                    reasonId: sharedPauseReason?.Id,
                });
                setPauseStart(null);
            } else {
                try {
                    await insertPause();
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

            // Batch runs write nothing at start - all rows are created at
            // submit, when the total window and unit count are known. The pause
            // queue is emptied here rather than only on a successful submit: a
            // batch that was abandoned, or whose submit failed, would otherwise
            // hand its pauses to whatever batch ran next.
            if (batchMode) {
                batchPauses.current = [];
                return;
            }

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
            const pauses = [...batchPauses.current];
            if (pauseStart) {
                pauses.push({
                    start: pauseStart,
                    end: endTime,
                    reasonId: sharedPauseReason?.Id,
                });
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
            batchPauses.current = [];

            const updatedTimes = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }
            window.electron.timerReset();
            setRefreshTrigger((prev) => prev + 1);
            setTimerDone(true);
            setDbSuccess(`${units} units ✅`);
            setErr("");
            setPauseStart(null);
        } catch (e: any) {
            setErr(String(e?.message ?? e));
            setDbSuccess("Submit");
        }
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
            if (typeof currentBuildId == "number") {
                const result = await writeTime(timeObject, currentBuildId, selectedUser?.Id);
                if (!result) {
                    return;
                }
            }

            const updatedTimes = await fetchTimes(selectedHarn, timerMode.id);
            if (Array.isArray(updatedTimes)) {
                setHarnBuilt(updatedTimes.length);
            }

            window.electron.timerReset();
            setRefreshTrigger((prev) => prev + 1); // ← triggers analytics to refresh
            setTimerDone(true);
            setDbSuccess("Success✅");
            setErr("");
            setPauseStart(null);

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
                <div id="nav-buttons">
                    <TimerButton />
                    <SettingsButton />
                    <ChooseHarnessButton />
                    <ChooseKitButton />
                </div>
                <p id="timer">{displayTimer}</p>

                <div className="harn-info-and-close-button">
                    <div className="harn-build-info">
                        <p id="current-build-pn">Part #: {selectedHarn}</p>
                        <p id="timer-mode">Timer Mode: {timerMode.header}</p>
                    </div>
                    <TimerModeDropdown/>
                    <div className="batch-controls">
                        <label className="batch-toggle">
                            <input
                                type="checkbox"
                                checked={batchMode}
                                disabled={!timerDone}
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
                                    disabled={!timerDone}
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
                <RTLogo />
            </div>
        </div>
    );
}

export default TimingPage;
