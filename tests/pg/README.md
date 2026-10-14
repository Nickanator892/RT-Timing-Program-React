# PostgreSQL engine tests

The Pi timer can run on the shared WHPP database on PostgreSQL (`db-config.json`
`"engine": "pg"`; `src/backend/pgEngine.ts`). SQLite stays the default. Brief:
Harness Pricing Program `docs/postgres/PI-PORT-BRIEF.md`.

## db-config on a Pi switched to PostgreSQL

```json
{
  "engine": "pg",
  "pg": {
    "host": "192.168.0.199",
    "port": 5432,
    "database": "whpp",
    "user": "timing_app",
    "passwordFile": "~/.config/rt-timing/timing_app.pw",
    "keyFile": "~/.config/rt-timing/rtmcs.key"
  },
  "rtmcsUrl": "http://192.168.0.199:8322"
}
```

- Never a `password` key: the app refuses to start the engine if there is one.
- `passwordFile` and `keyFile` default to the paths above. The first line of
  each file is the value. Both should be `chmod 600`, owned by the app user.
- The key file is RT-MCS's machine key. It is used only for `/api/timer/release`,
  because timing_app cannot read `msapikey`.
- Startup refuses every query while `whpp_schema` is behind (core 4, ms 2). The
  login page then shows the reason (db-status `readable:false`).

## Tests

| File | Needs | What it proves |
|---|---|---|
| `unit.test.ts` | nothing | `?` to `$n`, result-key case, config rules, error words |
| `bench.test.ts` | `SQLITE_SCRATCH` | the unchanged SQLite path, end to end, through a stand-in RT-MCS |
| `bench.test.ts` | `PG_BENCH_CONFIG` + `SQLITE_SCRATCH` | every read row for row; the same scenario writes the same rows on both engines; consecutive batch ids under a competing writer; ONE PLACE savepoint; lock_timeout + one retry; schema stamp fails closed |

```powershell
npx tsx --test tests/pg/unit.test.ts
$env:SQLITE_SCRATCH = "C:\Users\Randy Martens\AppData\Local\RT-Bench\db\whpp-sanitized-v2.db"
$env:PG_BENCH_CONFIG = "<db-config.json naming a whpp_bench_* clone>"
npx tsx --test --test-force-exit --test-concurrency=1 tests/pg/bench.test.ts
```

- `SQLITE_SCRATCH` must be the SQLite file the clone was loaded from. The tests
  only ever write a temp copy of it.
- `PG_BENCH_CONFIG` must name a `whpp_bench_*` clone, and the tests refuse
  anything else. They delete the rows they write.
- As timing_app (the Pi's own grants), run `Run-TimingAppBench.ps1` from an
  elevated prompt. timing_app's password file is admin-only. The script points
  the test config at that file and never reads or copies it.
