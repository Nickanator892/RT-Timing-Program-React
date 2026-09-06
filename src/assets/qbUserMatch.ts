/**
 * Propose a QuickBooks Time user for a shop builder.
 *
 * Builders are entered by first name or a nickname ("nicky", "caleb"); the
 * QuickBooks roster carries full legal names and login emails ("Nicholas
 * Martens" / "nicholas.martens", "Caleb Kehler" / "calebkeh@gmail.com"). Most
 * of that gap closes on a first-name comparison, and the rest has to be a
 * human's call - so this returns a CONFIDENCE and the caller decides what may
 * be applied without asking.
 *
 * Only `exact` and `strong` are ever linked automatically. `weak` is a
 * suggestion the operator confirms with a click; it exists because "nicky" and
 * "Nicholas Martens" are obviously the same person to a human and obviously not
 * to a string comparison.
 *
 * Every rule that could be ambiguous requires the match to be UNIQUE across the
 * roster. Three of the six QuickBooks users here share the surname Martens, so
 * a surname rule without that guard would confidently link the wrong person.
 */

export type MatchConfidence = "exact" | "strong" | "weak";

export interface QbRosterUser {
    qbTimeUserId: number;
    displayName: string | null;
    username?: string | null;
    active?: number | null;
}

export interface QbMatch {
    qbTimeUserId: number;
    displayName: string;
    confidence: MatchConfidence;
    /** Short human reason, shown next to the suggestion. */
    why: string;
}

/** Letters and digits only, lowercased: "Nicholas Martens" -> "nicholasmartens". */
function norm(s: string | null | undefined): string {
    return String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The part of a login before the @, so an email and a bare username compare alike. */
function localPart(s: string | null | undefined): string {
    const raw = String(s ?? "");
    const at = raw.indexOf("@");
    return at >= 0 ? raw.slice(0, at) : raw;
}

function nameTokens(displayName: string | null | undefined): string[] {
    return String(displayName ?? "")
        .split(/\s+/)
        .map(norm)
        .filter((t) => t.length > 0);
}

/** The single element satisfying the predicate, or null when zero or several do. */
function onlyOne<T>(items: T[], pred: (item: T) => boolean): T | null {
    const hits = items.filter(pred);
    return hits.length === 1 ? hits[0] : null;
}

/**
 * @param builderName  HARNBUILDERS.userName as typed by whoever added them.
 * @param roster       QBTIMEUSERS rows.
 * @param takenIds     QuickBooks users already linked to another builder - never
 *                     proposed, because one QuickBooks person is one builder.
 */
export function matchQbUser(
    builderName: string,
    roster: QbRosterUser[],
    takenIds: Iterable<number> = []
): QbMatch | null {
    const name = norm(builderName);
    if (!name) return null;

    const taken = new Set<number>(Array.from(takenIds, Number));
    const pool = roster.filter(
        (u) => u.active !== 0 && !taken.has(Number(u.qbTimeUserId)) && Number.isFinite(Number(u.qbTimeUserId))
    );
    if (pool.length === 0) return null;

    const made = (u: QbRosterUser, confidence: MatchConfidence, why: string): QbMatch => ({
        qbTimeUserId: Number(u.qbTimeUserId),
        displayName: String(u.displayName ?? `user ${u.qbTimeUserId}`),
        confidence,
        why,
    });

    // 1. The whole name, or the whole login, is the builder's name.
    const exact = onlyOne(
        pool,
        (u) => norm(u.displayName) === name || norm(localPart(u.username)) === name
    );
    if (exact) return made(exact, "exact", "name matches exactly");

    // 2. First name. The common case: "caleb" -> "Caleb Kehler".
    const byFirst = onlyOne(pool, (u) => nameTokens(u.displayName)[0] === name);
    if (byFirst) return made(byFirst, "strong", "first name matches");

    // 3. First token of a dotted login: "nicholas.martens" -> "nicholas".
    const byLogin = onlyOne(pool, (u) => norm(localPart(u.username).split(".")[0]) === name);
    if (byLogin) return made(byLogin, "strong", "login name matches");

    // 4. Surname - only when it picks out exactly one person. Three Martens on
    //    this roster is precisely why this cannot be trusted on its own.
    const byLast = onlyOne(pool, (u) => {
        const t = nameTokens(u.displayName);
        return t.length > 1 && t[t.length - 1] === name;
    });
    if (byLast) return made(byLast, "strong", "surname matches, and only one person has it");

    // 5. Shared opening letters, uniquely: "nicky" -> "Nicholas". Suggestion
    //    only. Three letters is short, which is why this never auto-applies.
    if (name.length >= 3) {
        const shares3 = (u: QbRosterUser) => {
            const first = nameTokens(u.displayName)[0] ?? "";
            return first.length >= 3 && first.slice(0, 3) === name.slice(0, 3);
        };
        const byPrefix = onlyOne(pool, shares3);
        if (byPrefix) {
            const first = nameTokens(byPrefix.displayName)[0] ?? "";
            return made(byPrefix, "weak", `"${builderName}" looks like a short form of "${first}"`);
        }
    }

    return null;
}

/** Confidences the caller may link without asking a human. */
export function isAutoLinkable(m: QbMatch | null): m is QbMatch {
    return m !== null && (m.confidence === "exact" || m.confidence === "strong");
}
