/**
 * Which way an update goes (Randy, ruling 119): every app becomes 2.0 at the
 * PostgreSQL cutover, and a 1.x tag made after that must never be installed
 * over it - that would put a SQLite-era build back on a PostgreSQL station.
 * The updater used to install whatever releases/latest named whenever it was
 * not EQUAL to what dpkg has; now it installs only a strictly newer version.
 *
 * Kept apart from update.ts (which runs the whole update when loaded) so it can
 * be tested on its own: npx tsx --test updater/versionOrder.test.ts
 */

/** [major, minor, patch] from "v1.0.35" or "1.0.35"; null for anything else. */
export function parseVersion(s: string): [number, number, number] | null {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s ?? "").trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** <0 when a is older than b, 0 when equal, >0 when newer. Both must parse. */
export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

export type UpdateDecision =
    /** latest is newer - or nothing usable is installed (not installed, or an
     *  install dpkg left half-done, which installedVersion() reports with its
     *  status after the version): install it, as before. */
    | "install"
    | "current"
    /** latest is OLDER than what is installed: never go backwards. */
    | "older"
    /** latest's tag is not a version number: nothing to compare, so nothing installed. */
    | "unreadable";

/** installed: installedVersion()'s answer ("v1.0.35", "v1.0.35 (half-installed)",
 *  "Not Installed"); latest: the releases/latest tag. */
export function decideUpdate(installed: string, latest: string): UpdateDecision {
    const have = parseVersion(installed);
    if (!have) return "install";
    const want = parseVersion(latest);
    if (!want) return "unreadable";
    const order = compareVersions(want, have);
    return order > 0 ? "install" : order === 0 ? "current" : "older";
}
