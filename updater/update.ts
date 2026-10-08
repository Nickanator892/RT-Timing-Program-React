import { execSync, exec, execFile, spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import ora from "ora";

const serverPort = 5000;
// The repo clone this script runs from (updater/ -> clone root).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TARGET =
    "/opt/rt-timing/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node";
// A fresh from-source build lands here (in this clone)...
const MODULE_BUILT = `${REPO_ROOT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
// ...and the last one that loaded is kept here, as the fallback.
const MODULE_CACHE = `${process.env.HOME}/better-sqlite3-build/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;

// Hard limits on the from-source rebuild. Neither npm step had one, so a stuck
// npm (registry or network trouble) held the updater - and the app, which is
// down for the whole update - for as long as it liked. When a limit is hit,
// everything npm started is killed and the known-good cache is used instead,
// so the fallback is always reached. For scale: the install took 3 s and the
// rebuild about 2 min on the Pi 5 (2026-10-06/07).
const NPM_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const NPM_REBUILD_TIMEOUT_MS = 10 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 30 * 1000;

// Single-instance lock: the boot-time service and the Settings-tab updater can
// run concurrently, and the loser's `dpkg -i` overwrites the winner's rebuilt
// module with the .deb's unusable one (seen 2026-08-27). mkdir is atomic; a
// lock older than 30 minutes is treated as stale (crashed run).
const LOCK_DIR = "/tmp/rt-timing-updater.lock";
let lockHeld = false;
function acquireLock(): boolean {
    try {
        fs.mkdirSync(LOCK_DIR);
        lockHeld = true;
        return true;
    } catch {
        try {
            const ageMs = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
            if (ageMs > 30 * 60 * 1000) {
                fs.rmdirSync(LOCK_DIR);
                fs.mkdirSync(LOCK_DIR);
                lockHeld = true;
                return true;
            }
        } catch {}
        return false;
    }
}
function releaseLock() {
    if (!lockHeld) return;   // never another run's lock
    lockHeld = false;
    try {
        fs.rmdirSync(LOCK_DIR);
    } catch {}
}

// Process groups runBounded() has started that may still be running.
const liveGroups = new Set<number>();

/**
 * Killed - systemctl stop, a shutdown, Ctrl-C or a closed window on the
 * Settings-tab run: take down what runBounded() started, which is in its own
 * process group and so no longer goes down with this one, and give the lock
 * back, so the next run is not shut out for half an hour.
 */
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
        for (const pgid of liveGroups) {
            try {
                process.kill(-pgid, "SIGKILL");
            } catch { /* already gone */ }
        }
        releaseLock();
        process.exit(128 + (os.constants.signals[sig] ?? 0));
    });
}

function run(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { cwd, maxBuffer: 1024 * 1024 * 500 }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
        });
    });
}

/**
 * run(), but it gives up after `timeoutMs` and kills everything the command
 * started. exec()'s own `timeout` is not enough for npm: it signals only the
 * shell, and its callback waits for stdout to close, which npm's children
 * (node-gyp, make, the compiler) hold open - so a stuck step still hangs. Here
 * the command gets its own process group and the whole group goes.
 */
function runBounded(command: string, timeoutMs: number, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
        const pgid = child.pid;
        if (pgid) liveGroups.add(pgid);
        let output = "";
        const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
        child.stdout?.on("data", keep);
        child.stderr?.on("data", keep);
        const killGroup = (signal: NodeJS.Signals) => {
            try {
                if (pgid) process.kill(-pgid, signal);
            } catch { /* already gone */ }
        };
        // SIGTERM now, SIGKILL for anything still there five seconds later.
        let stopping = false;
        const stopGroup = () => {
            stopping = true;
            killGroup("SIGTERM");
            setTimeout(() => {
                killGroup("SIGKILL");
                if (pgid) liveGroups.delete(pgid);
            }, 5000);
        };
        let settled = false;
        let grace: NodeJS.Timeout | undefined;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            clearTimeout(grace);
            stopGroup();
            reject(Object.assign(
                new Error(`timed out after ${Math.round(timeoutMs / 1000)} s: ${command}`),
                { timedOut: true }
            ));
        }, timeoutMs);
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            if (code === 0) resolve(output);
            else {
                const tail = output.trim().split("\n").slice(-5).join(" | ");
                reject(new Error(`${command} failed (${signal ?? `exit ${code}`}): ${tail}`));
            }
        };
        child.on("error", (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            if (pgid) liveGroups.delete(pgid);
            reject(err);
        });
        // 'close' comes once the output is all in, so the error text is whole.
        child.on("close", (code, signal) => {
            if (pgid && !stopping) liveGroups.delete(pgid);
            finish(code, signal);
        });
        // But a leftover grandchild can hold the output open long after the
        // command itself has finished. Give it two seconds, then stop waiting
        // and stop it - an open pipe would keep this script, and so the oneshot
        // unit, alive for as long as the leftover runs.
        child.on("exit", (code, signal) => {
            if (settled) return;
            clearTimeout(timer);   // the command is done; only the leftover is waited for
            grace = setTimeout(() => {
                child.stdout?.destroy();
                child.stderr?.destroy();
                stopGroup();
                finish(code, signal);
            }, 2000);
        });
    });
}

function download(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const process = spawn('wget', ['-O', dest, url], { stdio: 'ignore' });
        process.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`wget exited with code ${code}`));
        });
        process.on('error', reject);
    });
}

async function getLatestVersion() {
    const spinner = ora('Checking for updates...').start();
    try {
        const REPO = "Nickanator892/RT-Timing-Program-React";
        const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
        const latestVersion = await response.json();
        let currentVersion = await run("dpkg -l rt-timing | grep rt-timing | awk '{print $3}'");
        currentVersion = `v${currentVersion.trim()}`;
        if (currentVersion == "v") {
            currentVersion = "Not Installed"
        }
        const latestString: string = latestVersion.tag_name.toString().trim();
        if (currentVersion === latestString) {
            spinner.succeed(`Already on latest version ${currentVersion}`);
            return false;
        }
        spinner.succeed(`New version available: ${latestString} (current: ${currentVersion})`);
        return latestVersion;
    } catch(e: any) {
        spinner.fail(`Failed to get latest version: ${e}`);
        return;
    }
}

/**
 * Stop the running timer before replacing it on disk.
 *
 * This used to run `killall -q electron`, which matched NOTHING: the installed
 * binary is named `rt-timing`, not `electron`. The `|| true` then swallowed the
 * miss and the updater reported "Application stopped" while the old app kept
 * running. dpkg replaced the binary underneath it, a second instance started,
 * and the station ended up with two timers on screen - found 2026-09-11 with a
 * v1.0.15 process (its /proc/<pid>/exe reading "(deleted)") still alive
 * alongside the fresh v1.0.16 one.
 *
 * Now: ask it to go with SIGTERM, wait, and only then insist. SIGTERM matters -
 * the app writes a final heartbeat on the way out, so a build in progress keeps
 * the time it earned. SIGKILL loses at most one heartbeat interval, and is only
 * used if the app is still there after the grace period.
 */
const APP_PROCESS = 'rt-timing';
const APP_BINARY = '/opt/rt-timing/rt-timing';

/** Is the timer running on this station? `pgrep -x` matches the executable
 *  NAME exactly, so it cannot catch the updater's own `node`/`npx` processes
 *  the way a -f pattern could. */
async function appRunning(): Promise<boolean> {
    try {
        await run(`pgrep -x ${APP_PROCESS}`);
        return true;
    } catch {
        return false;   // pgrep exits non-zero when nothing matches
    }
}

async function killApplication() {
    const spinner = ora('Stopping application...').start();
    try {
        await run(`fuser -k ${serverPort}/tcp`);
        spinner.text = 'Killed server, stopping the app...';
    } catch {
        spinner.text = 'Server not running, stopping the app...';
    }

    const stillRunning = appRunning;

    try {
        await run(`pkill -TERM -x ${APP_PROCESS} || true`);
    } catch { /* nothing to signal */ }

    for (let i = 0; i < 15; i++) {
        if (!(await stillRunning())) {
            spinner.succeed('Application stopped');
            return;
        }
        spinner.text = `Waiting for the app to exit (${i + 1}/15)...`;
        await new Promise((r) => setTimeout(r, 1000));
    }

    spinner.text = 'App did not exit, forcing it...';
    try {
        await run(`pkill -KILL -x ${APP_PROCESS} || true`);
    } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 1000));

    if (await stillRunning()) {
        // Never report a stop that did not happen: installing over a running
        // app is how the station ends up with two of them.
        spinner.fail('Could NOT stop the running app - not installing over it');
        throw new Error(`${APP_PROCESS} is still running after SIGTERM and SIGKILL`);
    }
    spinner.succeed('Application stopped (forced)');
}

async function installFiles(newVersion: any) {
    const spinner = ora('Preparing installation...').start();
    try {
        const asset = newVersion.assets.find((a: any) => a.name.endsWith(".deb"));
        if (!asset) throw new Error("No .deb asset found in release");
        spinner.text = 'Downloading installer...';
        await download(asset.browser_download_url, '/tmp/rt-timing.deb');
        spinner.text = 'Running installer...';
        await run(`sudo dpkg -i /tmp/rt-timing.deb`);
        spinner.succeed('Installation complete!');
    } catch(e: any) {
        spinner.fail(`Installation failed: ${e}`);
    }
}

/** dlopen the EXACT file - a bare require() can resolve a different copy of
 *  the module and pass while the file we are about to ship does not exist
 *  (seen 2026-08-27: verify passed, cp then failed, app came up broken). */
async function verifyModuleFile(file: string) {
    await runBounded(`node -e "process.dlopen(module, '${file}')"`, VERIFY_TIMEOUT_MS);
}

/** Put `source` in place as the app's module, then prove the installed file
 *  loads. Copied in beside it and renamed over it, so a running app that has
 *  the old file open keeps its own copy rather than having it rewritten
 *  underneath it. */
async function installModule(source: string) {
    await run(`sudo cp ${source} ${MODULE_TARGET}.new && sudo mv -f ${MODULE_TARGET}.new ${MODULE_TARGET}`);
    await verifyModuleFile(MODULE_TARGET);
}

async function fixSQLite() {
    const spinner = ora('Rebuilding better-sqlite3 for the system Node - this may take a few minutes...').start();
    // The packaged app spawns its server with the system `node` from PATH
    // (see electron/main.js), so the module must match system Node's ABI.
    // The .deb does not ship a usable binary at all, so this step is the ONLY
    // source of a working module - it must fail loudly, never silently.
    try {
        let source = "";
        try {
            await runBounded(`npm install --omit=dev --no-audit --no-fund`, NPM_INSTALL_TIMEOUT_MS, REPO_ROOT);
            await runBounded(`npm rebuild better-sqlite3 --build-from-source`, NPM_REBUILD_TIMEOUT_MS, REPO_ROOT);
            await verifyModuleFile(MODULE_BUILT);
            source = MODULE_BUILT;
        } catch (buildErr: any) {
            // Fallback: the last known-good binary. Only used if it still
            // loads under the current node (an old-ABI cache must not ship).
            // Its own line, not spinner.text: off a terminal (the journal) ora
            // prints only start/succeed/warn/fail lines, so this used to vanish.
            spinner.warn(`Rebuild failed (${buildErr}); trying the last known-good binary...`);
            spinner.start("Installing the last known-good better-sqlite3...");
            await verifyModuleFile(MODULE_CACHE);
            source = MODULE_CACHE;
        }
        await installModule(source);
        // Refresh the fallback for next time.
        if (source === MODULE_BUILT) {
            await run(`mkdir -p ${path.dirname(MODULE_CACHE)} && cp ${MODULE_BUILT} ${MODULE_CACHE}`);
        }
        spinner.succeed(`better-sqlite3 verified and installed (from ${source === MODULE_BUILT ? "fresh build" : "known-good cache"})`);
    } catch (e: any) {
        spinner.fail(
            `better-sqlite3 could not be rebuilt OR restored - every database query will fail ` +
            `(empty builder/kit lists) until this is fixed manually: ${e}`
        );
    }
}

/**
 * Does the installed module load? A check that TIMES OUT is asked once more;
 * if node still does not answer, that is the Pi struggling, not proof that the
 * module is bad (a bad module fails at once), so the answer is "unknown" and
 * nothing gets replaced - or rebuilt, on a station somebody may be timing on.
 */
async function installedModuleLoads(): Promise<"yes" | "no" | "unknown"> {
    for (let attempt = 1; ; attempt++) {
        try {
            await verifyModuleFile(MODULE_TARGET);
            return "yes";
        } catch (e: any) {
            if (!e?.timedOut) {
                console.error(`better-sqlite3: the installed module does NOT load (${e}) - repairing it before the app starts.`);
                return "no";
            }
            if (attempt >= 2) {
                console.error(`better-sqlite3: could not check the installed module - node did not answer, twice (${e}). Leaving it as it is.`);
                return "unknown";
            }
        }
    }
}

/**
 * The gate in front of every start of the app: the module the app loads must
 * load. fixSQLite() used to be the only check, and it runs only right after an
 * install - so an install cut short (2026-10-07: the Pi restarted mid-rebuild)
 * left the .deb's x86-64 module in place, and the next run said "Already on
 * latest", started the app on it, and every query failed until it was fixed by
 * hand. Now every run checks it, cheapest repair first: the file already
 * installed, then the known-good cache, then a (time-limited) rebuild.
 *
 * If nothing loads, the app is started anyway (returns false, logged loudly):
 * a panel with no app on it tells nobody anything and gets switched off and on,
 * while a running app keeps /api/db-status up with the exact load error, and
 * the next run (07:30, a reboot, Settings > Check for update) tries again.
 *
 * `mayRebuild` is false when this run has already been through fixSQLite():
 * a second rebuild would only fail the same way, with the app still down.
 */
async function ensureModuleLoads(mayRebuild: boolean): Promise<boolean> {
    const installed = await installedModuleLoads();
    if (installed === "yes") {
        console.log("better-sqlite3: the installed module loads.");
        return true;
    }
    if (installed === "unknown") return false;
    try {
        await verifyModuleFile(MODULE_CACHE);
        await installModule(MODULE_CACHE);
        console.log("better-sqlite3: restored from the known-good cache, and the installed module now loads.");
        return true;
    } catch (e) {
        console.error(
            `better-sqlite3: the known-good cache did not fix it (${e})` +
            (mayRebuild ? " - rebuilding from source." : " - and this run's rebuild already failed.")
        );
    }
    if (mayRebuild) await fixSQLite();
    try {
        await verifyModuleFile(MODULE_TARGET);
        return true;
    } catch (e) {
        console.error(
            `!!! better-sqlite3 STILL DOES NOT LOAD (${e}). EVERY database query will fail (empty Select ` +
            `Builder) until it is fixed by hand - copy a module that loads to ${MODULE_TARGET}. ` +
            `Starting the app anyway so /api/db-status reports the error.`
        );
        return false;
    }
}

/**
 * Is somebody timing a build on this station right now - is a clock RUNNING?
 *
 * Randy, 2026-10-07: a PAUSED (or ended, awaiting Submit) build no longer holds
 * the update. Its worked time is already in the database (the pause writes the
 * frozen accumSeconds and heartbeatState PAUSE at once), and the app comes back
 * on it after the restart: session restore + the recovery flow put the operator
 * on the same build, paused, with the time it had and - since 1.0.29 - the
 * pause they took, start and reason. Only a running clock (heartbeatState RUN,
 * which a bobbin-change hold keeps too) or an unknown state holds. Updates are
 * only pushed outside 07:50-16:15 anyway; this is what lets one go through
 * when somebody left a build paused overnight or over a break.
 *
 * Asked of the app's own backend rather than the database directly, so the
 * updater never opens the shared SQLite file.
 *
 * When the app cannot be asked, the answer depends on whether it is running.
 * Not running: there is nothing to interrupt, so go ahead. Running but not
 * answering: HOLD. This used to carry on regardless, on the theory that an
 * unreachable backend is an app that is not serving - but on the Pi the
 * unreachable case was the updater's own doing. Until 2026-09-13 the app lived
 * inside this service's cgroup, so `systemctl restart rt-timing-updater` killed
 * it before this check ran, the ask failed, and every update went ahead without
 * ever having asked (both updates that day logged exactly that). An app that is
 * up and silent may well be mid-build: holding costs a day's update, guessing
 * wrong costs somebody's build.
 *
 * Set RT_TIMING_FORCE_UPDATE=1 to update anyway (used when the time on screen
 * has already been captured by hand).
 */
async function buildInProgress(): Promise<boolean> {
    if (process.env.RT_TIMING_FORCE_UPDATE === "1") {
        console.log("RT_TIMING_FORCE_UPDATE=1 - not checking for an open build.");
        return false;
    }
    const ATTEMPTS = 3;
    let lastError = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
            const res = await fetch(`http://localhost:${serverPort}/api/query`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Scoped to THIS station. Segments are stamped with the hostname
                // that opened them, and the updater runs on that same host, so
                // another panel's open build can never hold this one's update.
                body: JSON.stringify({
                    query:
                        "SELECT segmentId, buildId, heartbeatState, heartbeatAt FROM HARNBUILDSEGMENTS " +
                        "WHERE COALESCE(endTime,'') = '' AND stationId = ?",
                    params: [os.hostname()],
                }),
                signal: AbortSignal.timeout(8000),
            });
            const data: any = await res.json();
            // A refused or failed query is NOT "no open builds" - it is no
            // answer at all, and is treated exactly like an unreachable app.
            if (data?.success !== true || !Array.isArray(data?.result)) {
                throw new Error(data?.error ? String(data.error) : `unexpected answer (HTTP ${res.status})`);
            }
            // Anything but an explicit PAUSE - RUN, or no state recorded - is a
            // clock that may be running: hold.
            // A running clock heartbeats every minute. One silent for ORPHAN_MIN
            // minutes is not running on this panel (the app died mid-build and
            // the operator moved on): holding for it would block every update
            // for good. Stamps are local time on this same host.
            const ORPHAN_MIN = 10;
            const ageMin = (stamp: unknown): number => {
                const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(stamp ?? ""));
                if (!m) return Number.NaN;
                const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
                return (Date.now() - t) / 60_000;
            };
            const running = data.result.find((r: any) => {
                if (String(r.heartbeatState ?? "").toUpperCase() === "PAUSE") return false;
                const age = ageMin(r.heartbeatAt);
                if (Number.isFinite(age) && age > ORPHAN_MIN) {
                    console.log(`Segment ${r.segmentId} says ${r.heartbeatState ?? "no state"} but its last heartbeat was ${Math.round(age)} min ago - not a running clock.`);
                    return false;
                }
                return true;
            });
            if (running) {
                console.log(`A build is in progress (segment ${running.segmentId}, ${running.heartbeatState ?? "no state"}) - leaving the app alone.`);
                return true;
            }
            const paused = data.result.find((r: any) => String(r.heartbeatState ?? "").toUpperCase() === "PAUSE");
            if (paused) {
                console.log(
                    `Build ${paused.buildId} is open but PAUSED (segment ${paused.segmentId}) - ` +
                    `updating; the app restores it, paused, on restart.`
                );
            }
            return false;
        } catch (e) {
            lastError = String(e);
        }
        // The Settings tab's "Check for update" quits the app half a second
        // after starting this updater, so a failed ask can simply mean the app
        // is still on its way out. Look again before deciding it is stuck.
        if (!(await appRunning())) {
            console.log(`The app is not running (${lastError}) - nothing to interrupt.`);
            return false;
        }
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(
        `The app is running but could not be asked about open builds (${lastError}) - ` +
        `HOLDING the update rather than risk a live build. Set RT_TIMING_FORCE_UPDATE=1 to update anyway.`
    );
    return true;
}

/**
 * Start the timer in its OWN transient systemd unit, and return.
 *
 * It used to be `exec("/opt/rt-timing/rt-timing")` straight from this script,
 * which made the app part of rt-timing-updater.service for as long as it ran -
 * same cgroup, and a oneshot that never finished (found 2026-09-13):
 *  - the 07:30 timer fired into a unit still "activating" and did nothing, so
 *    the daily update check never actually ran;
 *  - `systemctl restart rt-timing-updater` stops the unit, which kills its whole
 *    cgroup, so the app was gone before buildInProgress() could ask it.
 *
 * `systemd-run` puts the app in rt-timing-app-<epoch>.service instead, and its
 * output in the journal (`journalctl -u 'rt-timing-app-*'`). KillMode=process
 * because the Settings tab's "Check for update" starts THIS script from inside
 * the app and then quits the app: with the default control-group kill, the app
 * exiting would take that updater down with it, mid-install.
 *
 * Never starts a second copy. Now that this script actually exits, the daily
 * check runs while the app is up, and the app has no single-instance lock.
 */
async function startApplication(): Promise<void> {
    if (await appRunning()) {
        console.log("The app is already running - leaving it alone.");
        return;
    }
    const me = os.userInfo();
    const unit = `rt-timing-app-${Math.floor(Date.now() / 1000)}`;
    const args = [
        "-n", "systemd-run",
        `--unit=${unit}`,
        "--description=RT Timing",
        "--collect",
        `--uid=${me.uid}`,
        `--gid=${me.gid}`,
        // Same cwd and display the app has always been started with.
        `--working-directory=${process.cwd()}`,
        `--setenv=DISPLAY=${process.env.DISPLAY || ":0"}`,
        `--setenv=LANG=${process.env.LANG || "en_GB.UTF-8"}`,
        "--property=KillMode=process",
        APP_BINARY,
    ];
    try {
        await new Promise<void>((resolve, reject) => {
            execFile("sudo", args, (err, _stdout, stderr) =>
                err ? reject(new Error(`${err.message} ${stderr}`.trim())) : resolve()
            );
        });
        console.log(`App started in its own unit: ${unit}.service`);
        return;
    } catch (e) {
        console.error(`Could not start the app through systemd-run (${e}) - starting it directly instead.`);
    }
    // Last resort, the old way. The app is then inside THIS unit, so this script
    // has to stay alive as long as the app does - if it exited, systemd would
    // kill the app along with it. The station keeps a timer, the daily check
    // is back to not running until this is sorted out.
    await new Promise<void>((resolve) => {
        const child = spawn(APP_BINARY, [], { stdio: "inherit" });
        child.on("exit", () => resolve());
        child.on("error", (err) => {
            console.error(`Could not start the app at all: ${err}`);
            resolve();
        });
    });
}

async function updateApplication() {
    console.log("Updating Application!")
    if (!acquireLock()) {
        console.log("Another updater instance is already running - exiting without touching the install.");
        return;
    }
    let rebuilt = false;
    try {
        const latestVersion = await getLatestVersion();
        if (latestVersion) {
            // Checked AFTER we know an update is even available, so a routine
            // daily poll with nothing new never touches a running build at all.
            // The app is up when the update is held or aborted, so the station
            // keeps working on the version it has (and startApplication()
            // below leaves it alone).
            if (!(await buildInProgress())) {
                let stopped = true;
                try {
                    await killApplication();
                } catch (e) {
                    // Installing over a running app is what produced two
                    // instances on one panel.
                    console.error(`Update aborted - could not stop the running app: ${e}`);
                    stopped = false;
                }
                if (stopped) {
                    await installFiles(latestVersion);
                    await fixSQLite();
                    rebuilt = true;
                    console.log("Update Complete!")
                }
            }
        }
        // Every path, "Already on latest" and a failed GitHub check included.
        // Also when the app was left running: a running app whose module does
        // not load cannot answer the open-build question either, so it holds
        // every update and would otherwise never be repaired. Inside the lock,
        // so another updater's dpkg cannot land on top of the repair.
        await ensureModuleLoads(!rebuilt);
    } finally {
        releaseLock();
    }
    // Outside the lock: in the last-resort path this waits as long as the app
    // runs, and a lock held for days would read as a crashed updater.
    // Every path, held and aborted updates too. The app is normally still
    // running then and is left alone - but it may have quit while the lock was
    // held (the Settings tab's "Check for update" quits it, and the updater it
    // starts finds the lock taken and goes), and then this brings it back.
    await startApplication();
}

/**
 * `npx tsx update.ts --check-guard` - read-only. Reports what an update would
 * decide about THIS station right now (is the app up, would it hold for an open
 * build) without checking GitHub, stopping, installing or starting anything.
 */
async function checkGuard() {
    console.log(`app running: ${await appRunning()}`);
    const hold = await buildInProgress();
    console.log(hold
        ? "decision: HOLD - an update now would leave the app alone"
        : "decision: GO - an update now would stop the app and install");
}

/**
 * `npx tsx update.ts --check-module` - read-only. Says whether each copy of the
 * better-sqlite3 module loads under this Pi's node (each check is a separate
 * `node` process; nothing is copied, built or started).
 */
async function checkModule() {
    const copies: [string, string][] = [
        ["installed in the app", MODULE_TARGET],
        ["known-good cache", MODULE_CACHE],
        ["last fresh build", MODULE_BUILT],
    ];
    for (const [name, file] of copies) {
        try {
            await verifyModuleFile(file);
            console.log(`${name}: loads (${file})`);
        } catch (e) {
            console.log(`${name}: does NOT load (${file}): ${e}`);
        }
    }
}

void (process.argv.includes("--check-guard") ? checkGuard()
    : process.argv.includes("--check-module") ? checkModule()
    : updateApplication());

/** Useful Commands 
 *  sudo dpkg --remove --force-remove-reinstreq rt-timing
 * 
*/