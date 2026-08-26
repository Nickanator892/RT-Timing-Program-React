import { execSync, exec, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import ora from "ora";

const serverPort = 5000;
// The repo clone this script runs from (updater/ -> clone root).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function fixSQLite() {
    const spinner = ora('Rebuilding better-sqlite3 for the system Node - this may take a few minutes...').start();
    try {
        // The packaged app spawns its server with the system `node` from PATH
        // (see electron/main.js), so the module must match system Node's ABI.
        // Build in THIS clone rather than a scratch cache dir: a binary cached
        // under an older Node install silently re-breaks every update - the
        // module fails to load ("libnode.so.108: cannot open shared object
        // file" / "Module did not self-register") and the UI shows empty
        // lists everywhere while db-status still reads ready.
        await run(`npm install --omit=dev --no-audit --no-fund`, REPO_ROOT);
        await run(`npm rebuild better-sqlite3 --build-from-source`, REPO_ROOT);
        // Prove the binary loads under this exact node BEFORE shipping it into
        // the app - a bad build must fail loudly here, not as empty UI lists.
        await run(`node -p "require('better-sqlite3') && 'ok'"`, REPO_ROOT);
        await run(
            `sudo cp ${REPO_ROOT}/node_modules/better-sqlite3/build/Release/better_sqlite3.node ` +
            `/opt/rt-timing/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
        );
        spinner.succeed('better-sqlite3 rebuilt and verified for the system Node!');
    } catch(e: any) {
        spinner.fail(`Failed to rebuild better-sqlite3 - database queries may fail (empty lists) until this is fixed: ${e}`);
    }
}

async function updateApplication() {
    console.log("Updating Application!")
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
}

updateApplication();

/** Useful Commands 
 *  sudo dpkg --remove --force-remove-reinstreq rt-timing
 * 
*/