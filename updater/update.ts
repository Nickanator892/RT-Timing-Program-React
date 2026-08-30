import { execSync, exec, spawn } from "child_process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import ora from "ora";

const serverPort = 5000;
// The repo clone this script runs from (updater/ -> clone root).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_TARGET =
    "/opt/rt-timing/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node";

// Single-instance lock: the boot-time service and the Settings-tab updater can
// run concurrently, and the loser's `dpkg -i` overwrites the winner's rebuilt
// module with the .deb's unusable one (seen 2026-08-27). mkdir is atomic; a
// lock older than 30 minutes is treated as stale (crashed run).
const LOCK_DIR = "/tmp/rt-timing-updater.lock";
function acquireLock(): boolean {
    try {
        fs.mkdirSync(LOCK_DIR);
        return true;
    } catch {
        try {
            const ageMs = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
            if (ageMs > 30 * 60 * 1000) {
                fs.rmdirSync(LOCK_DIR);
                fs.mkdirSync(LOCK_DIR);
                return true;
            }
        } catch {}
        return false;
    }
}
function releaseLock() {
    try {
        fs.rmdirSync(LOCK_DIR);
    } catch {}
}

function run(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(command, { cwd, maxBuffer: 1024 * 1024 * 500 }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(stdout);
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

async function killApplication() {
    const spinner = ora('Stopping application...').start();
    try {
        await run(`fuser -k ${serverPort}/tcp`);
        spinner.text = 'Killed server, stopping Electron...';
    } catch {
        spinner.text = 'Server not running, stopping Electron...';
    }
    try {
        await run(`killall -q electron || true`);
        spinner.succeed('Application stopped');
    } catch {
        spinner.succeed('Application was not running');
    }
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
    await run(`node -e "process.dlopen(module, '${file}')"`);
}

async function fixSQLite() {
    const spinner = ora('Rebuilding better-sqlite3 for the system Node - this may take a few minutes...').start();
    // The packaged app spawns its server with the system `node` from PATH
    // (see electron/main.js), so the module must match system Node's ABI.
    // The .deb does not ship a usable binary at all, so this step is the ONLY
    // source of a working module - it must fail loudly, never silently.
    const built = `${REPO_ROOT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
    const cached = `${process.env.HOME}/better-sqlite3-build/node_modules/better-sqlite3/build/Release/better_sqlite3.node`;
    try {
        let source = "";
        try {
            await run(`npm install --omit=dev --no-audit --no-fund`, REPO_ROOT);
            await run(`npm rebuild better-sqlite3 --build-from-source`, REPO_ROOT);
            await verifyModuleFile(built);
            source = built;
        } catch (buildErr: any) {
            // Fallback: the last known-good binary. Only used if it still
            // loads under the current node (an old-ABI cache must not ship).
            spinner.text = `Rebuild failed (${buildErr}); trying last known-good binary...`;
            await verifyModuleFile(cached);
            source = cached;
        }
        await run(`sudo cp ${source} ${MODULE_TARGET}`);
        // Final gate: the file actually installed into the app loads.
        await verifyModuleFile(MODULE_TARGET);
        // Refresh the fallback for next time.
        if (source === built) {
            await run(`mkdir -p ${path.dirname(cached)} && cp ${built} ${cached}`);
        }
        spinner.succeed(`better-sqlite3 verified and installed (from ${source === built ? "fresh build" : "known-good cache"})`);
    } catch (e: any) {
        spinner.fail(
            `better-sqlite3 could not be rebuilt OR restored - every database query will fail ` +
            `(empty builder/kit lists) until this is fixed manually: ${e}`
        );
    }
}

async function updateApplication() {
    console.log("Updating Application!")
    if (!acquireLock()) {
        console.log("Another updater instance is already running - exiting without touching the install.");
        return false;
    }
    try {
        const latestVersion = await getLatestVersion();
        if (!latestVersion) {
            exec("/opt/rt-timing/rt-timing")
            return false;
        }
        await killApplication();
        await installFiles(latestVersion);
        await fixSQLite();
        console.log("Update Complete!")
        exec("/opt/rt-timing/rt-timing")
        return true
    } finally {
        releaseLock();
    }
}

updateApplication();

/** Useful Commands 
 *  sudo dpkg --remove --force-remove-reinstreq rt-timing
 * 
*/