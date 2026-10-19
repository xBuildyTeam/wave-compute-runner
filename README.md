# wave-compute-runner v2

Headless runner for Wave OS on Theta EdgeCloud. One container, one HTTPS endpoint, `Authorization: Bearer $RUNNER_AUTH_TOKEN` on every call except `/health`.

## v1 (unchanged)
`POST /` `{files, command, args, timeoutSec<=60, runtime: shell|node|solidity}` returns `{exitCode, stdout, stderr, artifacts, durationMs}`. Solidity compiles with the real solc 0.8.14, evmVersion istanbul.

## v2 background jobs
Jobs keep running after the caller disconnects; poll for results.

| Call | Does |
|---|---|
| `GET /health` | version, chrome, thetaReview, running/queued, cpus, memMB (no auth) |
| `POST /jobs` | `{runtime, files?, command?, args?, timeoutSec<=7200, workspace?, env?, options?, fromJob?, fromFiles?}` returns `{jobId}` |
| `GET /jobs` | recent jobs |
| `GET /jobs/:id` | status (queued, running, succeeded, failed, timed_out, cancelled), exitCode, log tail, artifacts |
| `GET /jobs/:id/log?from=N` | log text from byte N |
| `GET /jobs/:id/file?path=P` | download one output file (max 20 MB) |
| `DELETE /jobs/:id` | cancel |

Runtimes: `shell`, `node`, `solidity`, `browser-bench`, `review`.
- `workspace: "name"` reuses a persistent folder across jobs (keep npm installs, caches).
- `fromJob` copies a finished job's output files (default `results.json`) into the new job.
- `browser-bench` options `{models:[index], engine:"wasm"|"webgpu", perModelTimeoutSec}` runs the Wave Lite AI benchmark page in headless Chromium (served with COOP/COEP, so the CPU path is multi-threaded) and writes `results.json`. Models stay cached in `/workspace/chrome-profile`.
- `review` uses Theta EdgeCloud on-demand models (`qwen3_8_flash` default, `qwen3_8_max`). `{mode:"bench", input:"results.json"}` grades every answer against reference answers and writes `review.json`. `{mode:"chat", requests:[{id, messages, max_tokens}]}` writes `responses.json`. Cost comes from Theta's own `cost_usd`.

Preinstalled: Node 22, solc loader, Chromium, Ganache 7.9.2, ethers 6.

## Env
- `RUNNER_AUTH_TOKEN` (required)
- `THETA_ONDEMAND_KEY` (for `review`; passed to jobs, never echoed in logs)
- `RUNNER_MAX_CONCURRENT` (default 2), `RUNNER_DATA_DIR` (default /workspace)

## Sizing
Browser jobs with 0.6B to 1B models need about 4 to 8 GB RAM. The old C1 (2 GB) tier only fits shell, Solidity and review jobs.
