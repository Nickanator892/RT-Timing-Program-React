/**
 * Put the people who actually use this panel at the top of every operator list.
 *
 * Randy, 2026-09-11. The builder list pages three at a time and the pickers are
 * in whatever order the query returned, so an active builder could sit on page
 * two while people who never touch that bench occupy page one - ashley was
 * behind Randy, nicky and caleb on the panel that she had been building on all
 * morning.
 *
 * Per-station, in localStorage, which is right: each bench has its own
 * regulars, and the order should not follow a person from panel to panel. It is
 * a display convenience only - nothing here is ever written to the database or
 * used to decide who a build belongs to.
 */
const KEY = "operatorRecent";
/** Long enough to cover everyone who touches one bench; short enough to stay a hint. */
const MAX = 20;

export function readRecentOperators(): number[] {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(Number).filter((n) => Number.isFinite(n));
    } catch {
        // Unreadable or blocked storage just means the default order.
        return [];
    }
}

/** Call when someone is CHOSEN - logged in, added as second operator, handed a build. */
export function rememberOperator(id: number | string | undefined | null): void {
    const n = Number(id);
    if (!Number.isFinite(n) || n <= 0) return;
    try {
        const next = [n, ...readRecentOperators().filter((x) => x !== n)].slice(0, MAX);
        localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        // A panel with storage blocked keeps working, just without the ordering.
    }
}

/**
 * Most recently chosen first; everyone else keeps the order they arrived in.
 * Array.prototype.sort is stable, so the untouched tail is not reshuffled -
 * which matters, because a list that reorders itself for no visible reason is
 * worse than one that never reorders at all.
 */
export function recentOperatorsFirst<T extends { Id: number | string }>(list: T[]): T[] {
    const recent = readRecentOperators();
    if (recent.length === 0) return list;
    const rank = new Map<number, number>(recent.map((id, i) => [id, i] as const));
    const rankOf = (u: T) => {
        const r = rank.get(Number(u.Id));
        return r === undefined ? Number.MAX_SAFE_INTEGER : r;
    };
    return [...list].sort((a, b) => rankOf(a) - rankOf(b));
}
