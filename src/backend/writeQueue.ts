import fs from "fs";
import path from "path";

/**
 * Writes that could not reach the database, kept on this machine until they do.
 *
 * Randy, 2026-09-12: losing contact with the database must not lose the work.
 * The panel has already proved it can: on 2026-09-11 a build sat with 15
 * minutes on screen and zero in the database, because the heartbeat had been
 * failing silently and nothing remembered the attempts.
 *
 * Append-only JSON Lines, one entry per line, fsync'd. A line that cannot be
 * parsed is skipped rather than poisoning the whole file - a half-written last
 * line after a power cut must cost that one entry, not the queue.
 *
 * WHAT BELONGS HERE. Only writes whose parameters are fully known when they are
 * made: heartbeats, pause rows, closing a segment. Anything whose result is
 * needed immediately - starting a build, writing a batch - must still fail
 * loudly, because a caller cannot use a row id that does not exist yet.
 * Queueing those would hand the page a build it could never write against.
 */

export interface QueuedStatement {
    query: string;
    params?: unknown[];
    /** Mirrors the worker's own guard: the replay fails if this many rows did not change. */
    requireChanges?: number;
}

export interface QueuedWrite {
    id: string;
    seq: number;
    createdAt: string;
    /** For the operator-facing message, e.g. "heartbeat" or "pause row". */
    kind: string;
    statements: QueuedStatement[];
    attempts: number;
    lastError?: string;
}

/** Kept small enough to replay quickly, large enough to cover a long outage. */
const MAX_ENTRIES = 5000;

export class WriteQueue {
    private readonly file: string;
    private entries: QueuedWrite[] = [];
    private seq = 0;
    private loaded = false;
    /** Entries the database actively rejected - kept, but never retried blindly. */
    private parked: QueuedWrite[] = [];

    constructor(dir: string, name = "pending-writes.jsonl") {
        this.file = path.join(dir, name);
    }

    get path(): string {
        return this.file;
    }

    load(): void {
        if (this.loaded) return;
        this.loaded = true;
        try {
            const raw = fs.readFileSync(this.file, "utf8");
            for (const line of raw.split("\n")) {
                const t = line.trim();
                if (!t) continue;
                try {
                    const e = JSON.parse(t) as QueuedWrite;
                    if (e && Array.isArray(e.statements) && e.statements.length) {
                        this.entries.push(e);
                        this.seq = Math.max(this.seq, Number(e.seq) || 0);
                    }
                } catch {
                    // One unreadable line - almost always a torn last write -
                    // must not take the rest of the queue with it.
                    console.warn("write queue: skipping an unreadable entry");
                }
            }
            if (this.entries.length) {
                console.log(`write queue: ${this.entries.length} write(s) waiting from a previous run`);
            }
        } catch {
            // No file is the normal case.
        }
    }

    get pending(): number {
        return this.entries.length;
    }

    get parkedCount(): number {
        return this.parked.length;
    }

    /** Oldest queued write's timestamp, for telling the operator how far behind we are. */
    get oldestAt(): string | null {
        return this.entries.length ? this.entries[0].createdAt : null;
    }

    add(kind: string, statements: QueuedStatement[], createdAt: string): QueuedWrite | null {
        this.load();
        if (this.entries.length >= MAX_ENTRIES) {
            console.error("write queue is full - refusing to queue another write");
            return null;
        }
        const entry: QueuedWrite = {
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            seq: ++this.seq,
            createdAt,
            kind,
            statements,
            attempts: 0,
        };
        this.entries.push(entry);
        this.rewrite();
        return entry;
    }

    /** Oldest first: a segment close must never be replayed before the pause inside it. */
    peek(): QueuedWrite | null {
        this.load();
        return this.entries[0] ?? null;
    }

    done(id: string): void {
        this.entries = this.entries.filter((e) => e.id !== id);
        this.rewrite();
    }

    /**
     * The database took the write and refused it on its own terms - a guard that
     * did not match, a constraint. Retrying forever would block everything
     * behind it, and dropping it would hide a real problem, so it is set aside
     * and reported.
     */
    park(id: string, error: string): void {
        const e = this.entries.find((x) => x.id === id);
        if (!e) return;
        e.lastError = error;
        this.parked.push(e);
        this.entries = this.entries.filter((x) => x.id !== id);
        this.rewrite();
        console.error(`write queue: parked ${e.kind} (${error})`);
    }

    /** Still cannot reach the database. Kept at the head, attempt count bumped. */
    retryLater(id: string, error: string): void {
        const e = this.entries.find((x) => x.id === id);
        if (!e) return;
        e.attempts++;
        e.lastError = error;
        this.rewrite();
    }

    parkedEntries(): QueuedWrite[] {
        return this.parked.slice();
    }

    /**
     * Rewritten whole rather than appended to. The queue is small, the file is
     * local, and a rewrite-then-rename is the only way a removal is as durable
     * as an addition - an append-only log would need compaction to ever shrink.
     */
    private rewrite(): void {
        const tmp = `${this.file}.tmp`;
        const body = this.entries.map((e) => JSON.stringify(e)).join("\n") + (this.entries.length ? "\n" : "");
        try {
            const fd = fs.openSync(tmp, "w");
            try {
                fs.writeFileSync(fd, body, "utf8");
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, this.file);
        } catch (err) {
            console.error(`write queue: could not persist (${err})`);
        }
    }
}
