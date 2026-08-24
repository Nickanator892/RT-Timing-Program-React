-- One-time migration: legacy 'dd/mm/yyyy-HH:MM:SS' timestamps -> 'yyyy-mm-dd HH:MM:SS'.
--
-- Run ONCE against the shared WHPP database when the release containing the
-- timestamp-format change is deployed (sqlite3 "WHPP Database.db" < migrate-timestamps.sql).
-- Mixed formats must not linger: HARNBUILDTIMES_VIEW takes MIN/MAX of segment
-- times as TEXT, and '11/08/2026-...' always text-sorts before '2026-08-12 ...',
-- so multi-segment builds aggregate wrongly until every row uses one format.
--
-- The LIKE guards make this idempotent - already-migrated rows don't match.
-- Legacy pause rows whose endTime was written time-only ('HH:MM:SS', a bug
-- fixed in the same release) don't match either; their date is unrecoverable.

UPDATE HARNBUILDSEGMENTS
SET startTime = substr(startTime,7,4)||'-'||substr(startTime,4,2)||'-'||substr(startTime,1,2)||' '||substr(startTime,12)
WHERE startTime LIKE '__/__/____-__:__:__';

UPDATE HARNBUILDSEGMENTS
SET endTime = substr(endTime,7,4)||'-'||substr(endTime,4,2)||'-'||substr(endTime,1,2)||' '||substr(endTime,12)
WHERE endTime LIKE '__/__/____-__:__:__';

UPDATE HARNBUILDTIMES
SET startTime = substr(startTime,7,4)||'-'||substr(startTime,4,2)||'-'||substr(startTime,1,2)||' '||substr(startTime,12)
WHERE startTime LIKE '__/__/____-__:__:__';

UPDATE HARNBUILDTIMES
SET endTime = substr(endTime,7,4)||'-'||substr(endTime,4,2)||'-'||substr(endTime,1,2)||' '||substr(endTime,12)
WHERE endTime LIKE '__/__/____-__:__:__';
