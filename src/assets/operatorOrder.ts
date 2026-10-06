/**
 * Builder lists run latest used first, least used last.
 *
 * Randy, 2026-09-11. The builder list pages three at a time and the pickers are
 * in whatever order the query returned, so an active builder could sit on page
 * two while people who never touch that bench occupy page one - ashley was
 * behind Randy, nicky and caleb on the panel that she had been building on all
 * morning.
 *
 * Randy, 2026-10-05: "User order should be in latest used to least used." The
 * order now comes from the database: useSettings loads each builder's last
 * time on a timer anywhere (`lastUsed` - as primary, handed a segment, or as
 * crew), the same rule as the RT-MCS phone timer's builder list. That covers
 * everyone, not only the people picked on this panel, and it survives a
 * power-off, which the panel's own list did not always. Someone picked here a
 * moment ago and not timed yet still goes to the top: the panel remembers WHEN
 * it last picked each person, and the later of the two times wins.
 *
 * A display convenience only - nothing here is ever written to the database or
 * used to decide who a build belongs to.
 */
// { builderId: epoch ms } - replaces "operatorRecent", which kept order only.
const KEY = "operatorChosenAt";
/** Long enough to cover everyone who touches one bench; short enough to stay a hint. */
const MAX = 20;

function readChosenAt(): Map<number, number> {
    try {
        const raw = localStorage.getItem(KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
        const out = new Map<number, number>();
        for (const [id, at] of Object.entries(parsed)) {
            const n = Number(id), t = Number(at);
            if (Number.isFinite(n) && Number.isFinite(t)) out.set(n, t);
        }
        return out;
    } catch {
        // Unreadable or blocked storage just means the database order.
        return new Map();
    }
}

/** Call when someone is CHOSEN - logged in, added as second operator, handed a build. */
export function rememberOperator(id: number | string | undefined | null): void {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    try {
        const chosen = readChosenAt();
        chosen.set(n, Date.now());
        const keep = [...chosen.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX);
        localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch {
        // A panel with storage blocked keeps working, just in database order.
    }
}

/** A local "YYYY-MM-DD HH:mm:ss" stamp as epoch ms; 0 when absent or unreadable. */
function stampMs(stamp: string | null | undefined): number {
    if (!stamp) return 0;
    const t = new Date(String(stamp).trim().replace(" ", "T")).getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * Latest used first: the later of the builder's last timer use (`lastUsed`,
 * when the list carries it) and the last time this panel picked them. People
 * with neither keep the order they arrived in - Array.prototype.sort is
 * stable, so the untouched tail is not reshuffled, which matters, because a
 * list that reorders itself for no visible reason is worse than one that
 * never reorders at all.
 */
export function recentOperatorsFirst<T extends { Id: number | string; lastUsed?: string | null }>(list: T[]): T[] {
    const chosen = readChosenAt();
    const at = (u: T) => Math.max(chosen.get(Number(u.Id)) ?? 0, stampMs(u.lastUsed));
    return [...list].sort((a, b) => at(b) - at(a));
}
