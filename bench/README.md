# mixed-signals benchmarks

Run:

- `pnpm bench --mode=inproc --profile=smoke`
- `pnpm bench:workers`
- `pnpm bench:full`
- `pnpm bench:d8` (auto-installs `v8`/`v8-debug` via `jsvu` and runs d8 inproc suite)
- `pnpm bench:d8:debug` (runs same suite on `v8-debug`)
- `pnpm bench:compare --base=bench/baselines/local.json --head=bench/results/latest.json`

Stability controls:

- warmup and measurement windows are profile-based.
- coefficient of variation is emitted per case.
- compare mode enforces regression thresholds on p95 latency and throughput.

Repro tips:

- close heavy background workloads.
- pin Node version and CPU governor.
- run `pnpm bench --profile=full` 3x and compare spread.
- for stable inproc VM numbers, prefer `pnpm bench:d8` over Node.
- d8 installs are pinned for reproducibility and use archive fallback if `jsvu` fetch fails.

CI:

- `.github/workflows/bench-pr.yml` benchmarks base SHA and PR head, compares results, and posts a PR comment table.
