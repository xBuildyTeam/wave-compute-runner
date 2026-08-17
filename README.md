# wave-compute-runner

Minimal sandboxed command/Solidity/Node runner for Wave OS, deployed as a Theta EdgeCloud containerized workload.

- Exposes a single `POST /` HTTP endpoint on port 8080.
- Requires `Authorization: Bearer <RUNNER_AUTH_TOKEN>` — set the token as an env var on the Theta template (never baked into the image).
- Accepts `{ files, command, args, timeoutSec, runtime }` — runtime is `shell`, `node`, or `solidity`.
