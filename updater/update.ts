import { execSync, exec, execFile, spawn, type ChildProcess } from "child_process";
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
// The same for the steps around it: the .deb download (wget's own defaults are
// a 15 min read timeout and 20 tries; it is ~180 MB, fetched while the app is
// still up), the GitHub check, which at boot is all that stands between the
// panel and the app, and the sudo cp/mv of the module.
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const GITHUB_TIMEOUT_MS = 30 * 1000;
const MODULE_COPY_TIMEOUT_MS = 2 * 60 * 1000;
// dpkg has NO limit (see dpkgOnce); past this it is taken to be hung. It waits,
// a little, for a dpkg lock held by apt-daily or PackageKit - before the app
// is stopped, and again (as a backstop) if dpkg still finds it taken.
const DPKG_SLOW_MS = 20 * 60 * 1000;
const DPKG_LOCK_WAIT_MS = 2 * 60 * 1000;
const DPKG_LOCK_RETRY_MS = 10 * 1000;
// Per user: a root-owned log left by a manual `sudo` run could not be reopened
// by pi in sticky /tmp (fs.protected_regular).
const DPKG_LOG = `/tmp/rt-timing-dpkg.${os.userInfo().uid}.log`;
// How long the update notice waits for the restarted app's server to answer,
// and then for its window: main.js shows it only after a recovery scan (up to
// 8 s) and the page load.
const APP_UP_WAIT_MS = 60 * 1000;
const APP_WINDOW_GRACE_MS = 15 * 1000;
// How often a notice that should be up but is not (no session yet at boot,
// zenity gone) is asked for again.
const NOTICE_RETRY_MS = 5 * 1000;
const DEB_PATH = "/tmp/rt-timing.deb";

// Single-instance lock: the boot-time service and the Settings-tab updater can
// run concurrently, and the loser's `dpkg -i` overwrites the winner's rebuilt
// module with the .deb's unusable one (seen 2026-08-27). mkdir is atomic; a
// lock older than 30 minutes is treated as stale (crashed run). A live run
// touches it every minute, so "stale" means crashed and never just slow - with
// the time limits above, a run that rebuilds can legitimately pass 20 minutes.
// It holds an owner token, so a run that was taken over as stale can never
// remove the lock of the run that took over.
const LOCK_DIR = "/tmp/rt-timing-updater.lock";
const LOCK_OWNER = path.posix.join(LOCK_DIR, "owner");
const lockToken = `${process.pid} ${Date.now()}`;
let lockHeld = false;
let lockBeat: NodeJS.Timeout | undefined;
function beatLock() {
    clearInterval(lockBeat);
    lockBeat = setInterval(() => {
        try {
            const now = new Date();
            fs.utimesSync(LOCK_DIR, now, now);
        } catch { /* gone - releaseLock() or a reboot */ }
    }, 60 * 1000);
    lockBeat.unref();
}
/** Owner token in the lock dir just made; on failure the dir goes again, so
 *  a full or read-only /tmp cannot leave a lock that nobody holds. */
function holdLock(): boolean {
    try {
        fs.writeFileSync(LOCK_OWNER, lockToken);
    } catch {
        try {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
        } catch { /* nothing more to do */ }
        return false;
    }
    lockHeld = true;
    beatLock();
    return true;
}
function readOwner(dir: string): string {
    try {
        return fs.readFileSync(path.posix.join(dir, "owner"), "utf8");
    } catch {
        return "";   // none (or a lock made by an older updater)
    }
}
function acquireLock(): boolean {
    try {
        fs.mkdirSync(LOCK_DIR);
    } catch {
        // Taken. Stale? Moved aside by rename, which only one taker can do to a
        // given dir; and if what got moved is not the stale lock that was looked
        // at (another taker already replaced it), it is put back.
        try {
            const staleOwner = readOwner(LOCK_DIR);
            if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs <= 30 * 60 * 1000) return false;
            const aside = `${LOCK_DIR}.stale.${process.pid}`;
            fs.renameSync(LOCK_DIR, aside);
            if (readOwner(aside) !== staleOwner) {
                fs.renameSync(aside, LOCK_DIR);
                return false;
            }
            fs.rmSync(aside, { recursive: true, force: true });
            fs.mkdirSync(LOCK_DIR);
        } catch {
            return false;
        }
    }
    return holdLock();
}
function releaseLock() {
    if (!lockHeld) return;   // never another run's lock
    lockHeld = false;
    clearInterval(lockBeat);
    try {
        if (fs.readFileSync(LOCK_OWNER, "utf8") !== lockToken) {
            console.error("The updater lock was taken over as stale by another run - leaving it to that run.");
            return;
        }
        fs.unlinkSync(LOCK_OWNER);
        fs.rmdirSync(LOCK_DIR);
    } catch {}
}

// Process groups spawnBounded() has started that may still be running.
const liveGroups = new Set<number>();
// The dpkg -i in progress, if any (runDpkg).
let dpkgChild: ChildProcess | undefined;
// True from the moment this run stopped the app until it has started it again.
let appStoppedByUs = false;

/**
 * SIGINT (Ctrl-C) or SIGTERM (systemctl stop, a shutdown): take down what
 * spawnBounded() started - it is in its own process group, so it no longer
 * goes down with this one - and give the lock back, so the next run is not
 * shut out for half an hour. Except while dpkg is installing: dpkg is never
 * killed from here (see runDpkg), and the lock is what keeps a second run's
 * download and dpkg off a live install - it is let go once dpkg has finished.
 * Under systemd the unit's control-group kill ends dpkg too, so that is quick.
 *
 * SIGHUP - the Settings-tab run's window was closed - is not a reason to stop
 * half way through an update that has already taken the app down: carry on,
 * and the app comes back at the end. Output to the dead terminal is dropped,
 * the spinners never touch stdin (see spin), and anything else that slips
 * through is logged rather than allowed to kill the run half way.
 */
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
        for (const pgid of liveGroups) {
            try {
                process.kill(-pgid, "SIGKILL");
            } catch { /* already gone */ }
        }
        const code = 128 + (os.constants.signals[sig] ?? 0);
        const leave = () => {
            if (appStoppedByUs) {
                console.error(
                    `!!! ${sig}: the updater stopped with the timer app DOWN. It comes back with the next updater ` +
                    `run (a reboot, 07:30, or Settings > Check for update).`
                );
            }
            closeNotice();
            releaseLock();
            process.exit(code);
        };
        const installing = dpkgChild;
        if (installing && installing.exitCode === null && installing.signalCode === null) {
            console.error(`${sig} while dpkg is installing - keeping the lock (and the notice) until dpkg has finished.`);
            installing.once("close", leave);
            return;
        }
        leave();
    });
}
process.on("SIGHUP", () => {
    console.error("The terminal was closed - carrying on with the update.");
});
for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => { /* a closed terminal */ });
}
process.on("uncaughtException", (e) => {
    console.error(`!!! Unexpected error in the updater, carrying on: ${e?.stack ?? e}`);
});
process.on("unhandledRejection", (e: any) => {
    console.error(`!!! Unhandled rejection in the updater: ${e?.stack ?? e}`);
});

/** An ora spinner that leaves stdin alone. ora's default (discardStdin) puts a
 *  terminal's stdin into raw mode; when the Settings-tab window is closed that
 *  turns into an EIO error that nothing handles, and the run died half way. */
function spin(text: string) {
    return ora({ text, discardStdin: false }).start();
}

/**
 * A window on the panel while the app is down for an update or a rebuild, so
 * nobody takes the empty screen for a hang and switches the Pi off - most
 * likely what cut the 2026-10-07 install short (somebody was at the panel, and
 * the Pi went down twice in seven minutes, both clean shutdowns).
 *
 * Best effort: no zenity or no display, no window, and the update goes on
 * regardless. While one is wanted it is asked for again every few seconds -
 * at boot the session can come up after the first try. zenity runs in its own
 * session, so a closed Settings-tab terminal or Ctrl-C does not take it down;
 * it reads its stdin, so whenever this script ends, however it ends, the pipe
 * closes and --auto-close takes the window down with it (zenity 3.44
 * progress.c: EOF + autoclose = quit). It never keeps this script alive: the
 * child and its pipe are unref'd.
 */
let notice: ChildProcess | undefined;
let noticeWanted: string | undefined;    // what the panel should be saying
let noticeRetry: NodeJS.Timeout | undefined;
/** Put the window up saying `text`, or make the one that is up say it. */
function notify(text: string) {
    noticeWanted = text;
    if (notice) sayNotice(text);
    else spawnNotice(text);
    if (!noticeRetry) {
        noticeRetry = setInterval(() => {
            if (noticeWanted && !notice) spawnNotice(noticeWanted);
        }, NOTICE_RETRY_MS);
        noticeRetry.unref();
    }
}
/** A window if none is wanted yet; one that is wanted keeps what it says. */
function showNotice(text: string) {
    if (noticeWanted) {
        if (!notice) spawnNotice(noticeWanted);
        return;
    }
    notify(text);
}
function spawnNotice(text: string) {
    if (notice) return;
    // The service runs with DISPLAY only; the panel's session is labwc on
    // Wayland, with Xwayland on :0 (2026-10-07).
    const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`;
    try {
        const child = spawn("zenity", [
            "--progress", "--pulsate", "--no-cancel", "--auto-close",
            "--title=RT Timing", `--text=${text}`, "--width=560",
        ], {
            stdio: ["pipe", "ignore", "ignore"],
            detached: true,
            env: {
                ...process.env,
                DISPLAY: process.env.DISPLAY || ":0",
                XDG_RUNTIME_DIR: runtimeDir,
                WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
                XAUTHORITY: process.env.XAUTHORITY || path.posix.join(os.homedir(), ".Xauthority"),
                DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=${runtimeDir}/bus`,
            },
        });
        child.stdin?.on("error", () => { /* zenity already gone */ });
        const forget = () => { if (notice === child) notice = undefined; };
        child.on("error", forget);   // no zenity
        child.on("exit", forget);    // no display, or closed by hand
        child.unref();
        (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
        notice = child;
    } catch { /* no window, carry on */ }
}
/** Change what the window says ("#..." lines on zenity's stdin; \n escapes). */
function sayNotice(text: string) {
    try {
        notice?.stdin?.write(`# ${text.replace(/\n/g, "\\n")}\n`);
    } catch { /* gone */ }
}
function closeNotice() {
    noticeWanted = undefined;
    clearInterval(noticeRetry);
    noticeRetry = undefined;
    const child = notice;
    notice = undefined;
    if (!child) return;
    child.kill();
    // One stuck on its display gets no second chance to hold anything up.
    setTimeout(() => {
        try {
            child.kill("SIGKILL");
        } catch { /* gone */ }
    }, 2000).unref();
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
function runBounded(command: string, timeoutMs: number, opts: BoundedOptions = {}): Promise<string> {
    return spawnBounded("/bin/sh", ["-c", command], timeoutMs, { label: command, ...opts });
}

interface BoundedOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** How the command is named in errors (default: file and args). */
    label?: string;
}

/** The same without a shell: `file` gets `args` exactly as given. */
function spawnBounded(file: string, args: string[], timeoutMs: number, opts: BoundedOptions = {}): Promise<string> {
    const command = opts.label ?? [file, ...args].join(" ");
    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd: opts.cwd,
            env: opts.env ?? process.env,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
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
                { timedOut: true, output }
            ));
        }, timeoutMs);
        const finish = (code: number | null, signal: NodeJS.Signals | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(grace);
            if (code === 0) resolve(output);
            else reject(Object.assign(
                new Error(`${command} failed (${signal ?? `exit ${code}`}): ${gist(output)}`),
                { output }
            ));
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

/** The line that says what went wrong, plus the last few. The compiler's or
 *  node-gyp's own complaint first; then node's "Error: <file>: cannot open
 *  shared object file", which node prints ABOVE its stack trace (the last
 *  lines alone were just the trace, "code: 'ERR_DLOPEN_FAILED'"); then npm's. */
function gist(output: string): string {
    const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
    const what =
        lines.find((l) => /fatal error|\berror:|gyp ERR! (stack Error|build error)/.test(l)) ??
        lines.find((l) => /^(\w*Error\b|npm (ERR!|error)|wget:|dpkg:|cp:|mv:)/.test(l));
    return [...new Set([what, ...lines.slice(-4)].filter(Boolean))].join(" | ");
}

/**
 * Fetch the release's .deb - while the app is still running: it is ~180 MB
 * over the shop Wi-Fi, and it used to be fetched after the app was stopped,
 * with the panel blank for as long as it took. Null if it could not be had;
 * nothing has changed then.
 */
async function downloadRelease(release: any): Promise<string | null> {
    const spinner = spin('Downloading the update...');
    try {
        const asset = release.assets.find((a: any) => a.name.endsWith(".deb"));
        if (!asset) throw new Error("No .deb asset found in release");
        // --timeout gives up on a stalled connection, the overall limit on the rest.
        await spawnBounded("wget", ["-nv", "--timeout=60", "--tries=3", "-O", DEB_PATH, asset.browser_download_url],
            DOWNLOAD_TIMEOUT_MS);
        const size = fs.statSync(DEB_PATH).size;
        if (typeof asset.size === "number" && size !== asset.size) {
            throw new Error(`downloaded ${size} bytes, the release says ${asset.size}`);
        }
        spinner.succeed(`Downloaded ${asset.name} (${Math.round(size / (1024 * 1024))} MB)`);
        return DEB_PATH;
    } catch (e: any) {
        spinner.fail(`Download failed - nothing was changed: ${e}`);
        return null;
    }
}

/**
 * The installed version as "v1.2.3", or something that can never equal a tag
 * when there is no complete install. The STATUS matters as much as the
 * version: a dpkg run cut short (a reboot mid-install) leaves the new version
 * recorded as half-installed, unpacked or half-configured, and comparing the
 * version alone said "Already on latest" over a half-replaced app - so that
 * now installs again. Once per boot per version, though, whatever state the
 * first try left behind: if a reinstall that really ran did not cure it, doing
 * it on every run would only take the app down every day for nothing (/tmp is
 * emptied at boot). The mark is written only once dpkg has actually run.
 */
const REINSTALL_MARK = "/tmp/rt-timing-reinstall-tried";
let reinstallFor = "";   // the version this run is reinstalling to repair its state
async function installedVersion(): Promise<string> {
    let out = "";
    try {
        out = (await run(`dpkg-query -W -f='\${Status}|\${Version}' rt-timing`)).trim();
    } catch {
        return "Not Installed";   // dpkg-query exits non-zero for an unknown package
    }
    const [status = "", version = ""] = out.split("|");
    if (!version) return "Not Installed";
    const [, flag, state] = status.split(" ");
    // Complete, whatever the "want" (install, hold): triggers-* only wait on
    // OTHER packages' triggers, and the app's own files are all in place.
    if (flag === "ok" && ["installed", "triggers-pending", "triggers-awaited"].includes(state)) {
        return `v${version}`;
    }
    if (flag === "reinstreq" || ["half-installed", "unpacked", "half-configured"].includes(state)) {
        let tried = "";
        try {
            tried = fs.readFileSync(REINSTALL_MARK, "utf8");
        } catch { /* not this boot */ }
        if (tried === version) {
            console.error(`dpkg still has rt-timing ${version} as "${status}" after a reinstall this boot - not trying again until the next boot.`);
            return `v${version}`;
        }
        console.error(`dpkg has rt-timing ${version} as "${status}" - an install was cut short; it will be installed again.`);
        reinstallFor = version;
        return `v${version} (${status})`;
    }
    return "Not Installed";   // config-files, not-installed
}

async function getLatestVersion() {
    const spinner = spin('Checking for updates...');
    try {
        const REPO = "Nickanator892/RT-Timing-Program-React";
        const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
            signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
        const latestVersion = await response.json();
        const currentVersion = await installedVersion();
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
    const spinner = spin('Stopping application...');
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

/** Install the downloaded .deb. False if dpkg failed - part way, possibly,
 *  which the module check before the start copes with. */
async function installDeb(deb: string): Promise<boolean> {
    const spinner = spin('Running installer...');
    let ran = false;
    try {
        await runDpkg(deb);
        ran = true;
        spinner.succeed('Installation complete!');
        return true;
    } catch(e: any) {
        // A lock that never came free, or a dpkg that never started, is not a
        // reinstall that failed.
        ran = !e?.locked && !e?.notRun;
        spinner.fail(`Installation failed: ${e}`);
        return false;
    } finally {
        if (reinstallFor && ran) {
            try {
                fs.writeFileSync(REINSTALL_MARK, reinstallFor);
            } catch { /* then it may be tried again; no worse than before */ }
        }
    }
}

/** Is another package tool (apt-daily, PackageKit, a desktop update) holding
 *  dpkg's locks? Asked BEFORE the app is stopped, so waiting costs nothing. */
async function dpkgBusy(): Promise<boolean> {
    try {
        await run("sudo -n fuser -s /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock");
        return true;    // fuser found a process with one of them open
    } catch {
        return false;   // none (or no fuser/sudo - then dpkg's own retry is the backstop)
    }
}
async function waitForDpkg(): Promise<boolean> {
    const giveUp = Date.now() + DPKG_LOCK_WAIT_MS;
    while (await dpkgBusy()) {
        if (Date.now() > giveUp) return false;
        console.log(`Another package tool is using dpkg - waiting ${DPKG_LOCK_RETRY_MS / 1000} s before stopping the app...`);
        await new Promise((r) => setTimeout(r, DPKG_LOCK_RETRY_MS));
    }
    return true;
}

/** dpkg -i, waiting up to DPKG_LOCK_WAIT_MS for a dpkg lock held by another
 *  package tool (apt-daily, PackageKit): dpkg itself fails at once on it. */
async function runDpkg(deb: string): Promise<void> {
    const giveUp = Date.now() + DPKG_LOCK_WAIT_MS;
    for (;;) {
        try {
            await dpkgOnce(deb);
            return;
        } catch (e: any) {
            if (!e?.locked || Date.now() > giveUp) throw e;
            console.error(`dpkg is locked by another package tool - trying again in ${DPKG_LOCK_RETRY_MS / 1000} s.`);
            await new Promise((r) => setTimeout(r, DPKG_LOCK_RETRY_MS));
        }
    }
}

/**
 * One `sudo dpkg -i`, with NO time limit and in its own session: killing dpkg
 * part way is exactly the half-installed app this script has to look out for,
 * so nothing here kills it - not a limit, not the signal handler (it waits for
 * dpkg instead), and not a closed window on the Settings-tab run (no terminal
 * signals reach another session). `systemctl stop` still can, deliberately.
 * Its output goes to a file, not to pipes into this script, so dpkg and its
 * maintainer scripts never write into a closed pipe, and nothing they leave
 * running can keep this waiting once dpkg has exited. Non-interactive, keeping
 * any locally changed conffile: with no terminal a prompt would abort it.
 * Past DPKG_SLOW_MS it is taken to be hung: said loudly (and on the panel),
 * and the lock is no longer kept fresh, so a later run can take over.
 */
function dpkgOnce(deb: string): Promise<void> {
    return new Promise((resolve, reject) => {
        let fd: number;
        try {
            fd = fs.openSync(DPKG_LOG, "w");
        } catch (e) {
            reject(Object.assign(e as Error, { notRun: true }));
            return;
        }
        let child: ChildProcess;
        try {
            child = spawn("sudo", [
                "env", "DEBIAN_FRONTEND=noninteractive",
                "dpkg", "--force-confdef", "--force-confold", "-i", deb,
            ], { detached: true, stdio: ["ignore", fd, fd] });
        } finally {
            fs.closeSync(fd);   // the child has its own copy
        }
        dpkgChild = child;
        let settled = false;
        const slow = setTimeout(() => {
            console.error(
                `dpkg has been running for ${DPKG_SLOW_MS / 60000} minutes and looks hung - leaving it be. ` +
                `The lock is no longer kept fresh, so a later run can take over.`
            );
            notify("This is taking much longer than it should.\nLeave the Pi switched on and get someone to look at it.");
            clearInterval(lockBeat);
        }, DPKG_SLOW_MS);
        const done = (err?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(slow);
            if (dpkgChild === child) dpkgChild = undefined;
            if (lockHeld) beatLock();   // in case the slow mark stopped it
            if (err) reject(err);
            else resolve();
        };
        child.on("error", (err) => done(Object.assign(err, { notRun: true })));
        child.on("close", (code, signal) => {
            if (code === 0) return done();
            let output = "";
            try {
                output = fs.readFileSync(DPKG_LOG, "utf8").slice(-4000);
            } catch { /* no log */ }
            done(Object.assign(new Error(`sudo dpkg -i failed (${signal ?? `exit ${code}`}): ${gist(output)}`), {
                output,
                locked: /locked by another process|could not get lock|frontend lock/i.test(output),
            }));
        });
    });
}

/** dlopen the EXACT file - a bare require() can resolve a different copy of
 *  the module and pass while the file we are about to ship does not exist
 *  (seen 2026-08-27: verify passed, cp then failed, app came up broken). */
async function verifyModuleFile(file: string) {
    await spawnBounded("node", ["-e", "process.dlopen(module, process.argv[1])", file], VERIFY_TIMEOUT_MS);
}

/** verifyModuleFile, asked again once if it only TIMED OUT - a Pi still busy
 *  after a two-minute compile is not a reason to throw a good build away. */
async function verifyPatiently(file: string) {
    try {
        await verifyModuleFile(file);
    } catch (e: any) {
        if (!e?.timedOut) throw e;
        await verifyModuleFile(file);
    }
}

/** Put `source` in place as the app's module, then prove the installed file
 *  loads. Copied in beside it and renamed over it, so a running app that has
 *  the old file open keeps its own copy rather than having it rewritten
 *  underneath it. */
async function installModule(source: string) {
    await spawnBounded("sudo", ["cp", source, `${MODULE_TARGET}.new`], MODULE_COPY_TIMEOUT_MS);
    await spawnBounded("sudo", ["mv", "-f", `${MODULE_TARGET}.new`, MODULE_TARGET], MODULE_COPY_TIMEOUT_MS);
    await verifyPatiently(MODULE_TARGET);
}

/**
 * Build better-sqlite3 from source in this clone, for the system node, and
 * prove the result loads.
 *
 * `npm rebuild` first, as always, but with build-from-source passed in the
 * environment rather than as `--build-from-source`: npm 11.19 already warns
 * that flag "will stop working in the next major version", npm 12 rejects
 * unknown flags outright, and the environment form is still honoured there.
 * npm 12 also stops running dependencies' install scripts unless package.json
 * allows them. When npm compiled nothing at all, the package's own
 * `build-release` script (node-gyp rebuild --release - all the install script
 * ends up running here) is run explicitly: an `npm run` in the package is not
 * a dependency install script, so allowScripts does not apply, and npm still
 * hands it its environment and its node-gyp. Never a second compile after a
 * first one that RAN - failed, timed out, or built a module that will not
 * load: it would only do the same again, with the app still down.
 *
 * The old build is deleted first, so a module found afterwards is this run's.
 */
async function buildModule() {
    try {
        fs.rmSync(MODULE_BUILT, { force: true });
    } catch { /* then the dlopen check below is still the judge */ }
    let rebuildErr: any;
    try {
        await runBounded("npm rebuild better-sqlite3", NPM_REBUILD_TIMEOUT_MS, {
            cwd: REPO_ROOT,
            env: { ...process.env, npm_config_build_from_source: "true" },
        });
    } catch (e) {
        rebuildErr = e;
    }
    if (!rebuildErr && fs.existsSync(MODULE_BUILT)) {
        await verifyPatiently(MODULE_BUILT);
        return;
    }
    const compiled = /gyp (info|ERR!)|make(\[\d+\])?: \*\*\*/.test(String(rebuildErr?.output ?? ""));
    if (rebuildErr && (rebuildErr.timedOut || compiled)) throw rebuildErr;
    console.error(
        `npm rebuild ${rebuildErr ? `failed before compiling (${rebuildErr})` : "left no module (its install script did not run)"}` +
        ` - running better-sqlite3's build-release.`
    );
    await runBounded("npm run build-release", NPM_REBUILD_TIMEOUT_MS, {
        cwd: path.posix.join(REPO_ROOT, "node_modules", "better-sqlite3"),
    });
    await verifyPatiently(MODULE_BUILT);
}

const REPAIRING = "Repairing the build timer.\nIt will be back in a few minutes - please do not switch the Pi off.";

/** `repairNotice`: what the panel says while this runs, if the app is down
 *  (none during an update - the update's own notice is up then). */
async function fixSQLite(repairNotice?: string) {
    if (repairNotice && !(await appRunning())) {
        notify(repairNotice);
    }
    const spinner = spin('Rebuilding better-sqlite3 for the system Node - this may take a few minutes...');
    // The packaged app spawns its server with the system `node` from PATH
    // (see electron/main.js), so the module must match system Node's ABI.
    // The .deb does not ship a usable binary at all, so this step is the ONLY
    // source of a working module - it must fail loudly, never silently.
    try {
        let source = "";
        try {
            await runBounded(`npm install --omit=dev --no-audit --no-fund`, NPM_INSTALL_TIMEOUT_MS, { cwd: REPO_ROOT });
            await buildModule();
            source = MODULE_BUILT;
        } catch (buildErr: any) {
            // Fallback: the last known-good binary. Only used if it still
            // loads under the current node (an old-ABI cache must not ship).
            // Its own line, not spinner.text: off a terminal (the journal) ora
            // prints only start/succeed/warn/fail lines, so this used to vanish.
            spinner.warn(`Rebuild failed (${buildErr}); trying the last known-good binary...`);
            spinner.start("Installing the last known-good better-sqlite3...");
            await verifyPatiently(MODULE_CACHE);
            source = MODULE_CACHE;
        }
        await installModule(source);
        // Refresh the fallback for next time - copied in and renamed over, as
        // the Pi does get switched off, and only a warning if it fails: the
        // module the app needs is already in place by now.
        if (source === MODULE_BUILT) {
            try {
                await run(
                    `mkdir -p ${path.dirname(MODULE_CACHE)} && cp ${MODULE_BUILT} ${MODULE_CACHE}.new && ` +
                    `mv -f ${MODULE_CACHE}.new ${MODULE_CACHE}`
                );
            } catch (e) {
                console.error(`Could not refresh the known-good cache (${e}) - the installed module is fine; the old cache stays.`);
            }
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
        await verifyPatiently(MODULE_CACHE);
        await installModule(MODULE_CACHE);
        console.log("better-sqlite3: restored from the known-good cache, and the installed module now loads.");
        return true;
    } catch (e) {
        console.error(
            `better-sqlite3: the known-good cache did not fix it (${e})` +
            (mayRebuild ? " - rebuilding from source." : " - and this run's rebuild already failed.")
        );
    }
    if (mayRebuild) await fixSQLite(REPAIRING);
    try {
        await verifyPatiently(MODULE_TARGET);
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
/** True if this started the app; false if it was running already. */
async function startApplication(): Promise<boolean> {
    if (await appRunning()) {
        console.log("The app is already running - leaving it alone.");
        return false;
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
        return true;
    } catch (e) {
        console.error(`Could not start the app through systemd-run (${e}) - starting it directly instead.`);
    }
    // Last resort, the old way. The app is then inside THIS unit, so this script
    // has to stay alive as long as the app does - if it exited, systemd would
    // kill the app along with it. The station keeps a timer, the daily check
    // is back to not running until this is sorted out.
    closeNotice();   // this waits for as long as the app runs
    await new Promise<void>((resolve) => {
        const child = spawn(APP_BINARY, [], { stdio: "inherit" });
        child.on("exit", () => resolve());
        child.on("error", (err) => {
            console.error(`Could not start the app at all: ${err}`);
            resolve();
        });
    });
    return true;
}

async function updateApplication() {
    console.log("Updating Application!")
    if (!acquireLock()) {
        console.log("Another updater instance is already running - exiting without touching the install.");
        return;
    }
    let rebuilt = false;
    try {
        // At boot the panel is empty until the app is up: say so from the start
        // (best effort - the session may not be up yet; it is asked again below).
        if (!(await appRunning())) showNotice(STARTING);
        try {
            const latestVersion = await getLatestVersion();
            // Checked AFTER we know an update is even available, so a routine
            // daily poll with nothing new never touches a running build at all.
            // The app is up when the update is held or aborted, so the station
            // keeps working on the version it has (and startApplication()
            // below leaves it alone).
            if (latestVersion && !(await buildInProgress())) {
                const updating =
                    `Updating the build timer to ${latestVersion.tag_name}.\n` +
                    `It will be back in a few minutes - please do not switch the Pi off.`;
                // At boot, or after the Settings tab quit it, the app is down already.
                if (!(await appRunning())) notify(updating);
                // And it can go during the download (the Settings tab quits it half
                // a second after starting this): the window goes up when it does.
                let watching = true;
                const watch = setInterval(() => {
                    void appRunning().then((up) => { if (watching && !up && !noticeWanted) notify(updating); });
                }, 5000);
                let deb: string | null;
                try {
                    deb = await downloadRelease(latestVersion);
                } finally {
                    watching = false;
                    clearInterval(watch);
                }
                // Asked again: somebody may have started timing during the download.
                // And dpkg must be free (apt-daily, PackageKit) before the app is
                // stopped - waiting for it with the app down was downtime for nothing.
                if (deb && !(await buildInProgress()) && await waitForDpkgOrSay()) {
                    let stopped = true;
                    try {
                        await killApplication();
                        appStoppedByUs = true;
                    } catch (e) {
                        // Installing over a running app is what produced two
                        // instances on one panel.
                        console.error(`Update aborted - could not stop the running app: ${e}`);
                        stopped = false;
                    }
                    if (stopped) {
                        notify(updating);
                        if (await installDeb(deb)) {
                            await fixSQLite();
                            rebuilt = true;
                            console.log("Update Complete!")
                        } else {
                            // Nothing new to rebuild for: the check below sees
                            // to the module, and the panel gets its app back.
                            console.error("Update failed - starting the version that is installed.");
                        }
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
        if (!(await appRunning())) notify(STARTING);
        const started = await startApplication();
        appStoppedByUs = false;
        if (!started) {
            // Running already (left alone, or started by someone else meanwhile):
            // nothing to cover, and a "do not switch off" over a live timer is wrong.
            closeNotice();
        } else if (noticeWanted) {
            // The notice stays until the app's server answers and its window has
            // had time to show, rather than leave the panel blank while it starts.
            await appAnswers(APP_UP_WAIT_MS);
        }
    } finally {
        closeNotice();
    }
}

const STARTING = "Starting the build timer...";

async function waitForDpkgOrSay(): Promise<boolean> {
    if (await waitForDpkg()) return true;
    console.error(
        `Another package tool kept dpkg busy for ${DPKG_LOCK_WAIT_MS / 60000} minutes - not updating this run; ` +
        `the app keeps running and the next run tries again.`
    );
    return false;
}

/** Wait, at most `ms`, for the app's own server to answer, then a while for
 *  its window: electron/main.js creates it once /api/db-status answers and
 *  shows it when the page has loaded. */
async function appAnswers(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        try {
            await fetch(`http://localhost:${serverPort}/api/db-status`, { signal: AbortSignal.timeout(2000) });
            await new Promise((r) => setTimeout(r, APP_WINDOW_GRACE_MS));
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }
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