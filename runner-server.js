// Wave compute runner v2.
// v1 contract kept as-is: POST / {files, command, args, timeoutSec<=60, runtime} -> {exitCode, stdout, stderr, artifacts, durationMs}
// v2 adds background jobs that survive the caller disconnecting:
//   GET  /health                      (no auth) version, chrome, queue, memory
//   POST /jobs                        {files, command, args, runtime, timeoutSec<=7200, workspace?, env?} -> {jobId}
//   GET  /jobs                        recent jobs
//   GET  /jobs/:id                    status, exitCode, log tail, artifacts list
//   GET  /jobs/:id/log?from=N         log bytes from offset N
//   GET  /jobs/:id/file?path=P        one file from the job dir (artifact download)
//   DELETE /jobs/:id                  cancel
// runtimes: shell | node | solidity | browser-bench | review
// Secrets (THETA_ONDEMAND_KEY) stay in the container env and are never echoed back.
const http = require('http');
const { execFile, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const VERSION = '2.0.0';
const AUTH = process.env.RUNNER_AUTH_TOKEN || '';
const PORT = process.env.PORT || 8080;
const DATA = process.env.RUNNER_DATA_DIR || '/workspace';
const MAX_CONCURRENT = Number(process.env.RUNNER_MAX_CONCURRENT || 2);
const MAX_JOB_SEC = 7200;
const LOG_CAP = 4 * 1024 * 1024;
const JOBS_DIR = path.join(DATA, 'jobs');
const WS_DIR = path.join(DATA, 'workspaces');
fs.mkdirSync(JOBS_DIR, { recursive: true });
fs.mkdirSync(WS_DIR, { recursive: true });

const SECRET_VALUES = ['THETA_ONDEMAND_KEY', 'RUNNER_AUTH_TOKEN'].map(k => process.env[k]).filter(v => v && v.length >= 8);
const redact = s => { for (const v of SECRET_VALUES) s = s.split(v).join('[redacted]'); return s; };

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function authed(req) {
  const t = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  if (!AUTH || !t) return false;
  const a = Buffer.from(t), b = Buffer.from(AUTH);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readBody(req, limit = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function safeJoin(base, rel) {
  const p = path.resolve(base, rel || '');
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('path escapes job dir');
  return p;
}
function writeFiles(dir, files) {
  for (const f of files || []) {
    const fp = safeJoin(dir, f.path);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, f.encoding === 'base64' ? Buffer.from(f.content || '', 'base64') : (f.content || ''));
  }
}

// ---------- solidity (unchanged from v1) ----------
let solcLib = null, cachedCompiler = null;
const SOLC_VERSION = 'v0.8.14+commit.80d49f37';
function getSolcLib() { if (!solcLib) solcLib = require(path.join(execSync('npm root -g').toString().trim(), 'solc')); return solcLib; }
function loadCompiler() {
  return new Promise((resolve, reject) => {
    if (cachedCompiler) return resolve(cachedCompiler);
    let solc; try { solc = getSolcLib(); } catch (e) { return reject(e); }
    solc.loadRemoteVersion(SOLC_VERSION, (err, snap) => { if (err) return reject(err); cachedCompiler = snap; resolve(snap); });
  });
}
async function compileSolidity(files) {
  const solc = await loadCompiler();
  const sources = {};
  for (const f of files) if (f.path.endsWith('.sol')) sources[f.path] = { content: f.content || '' };
  const input = { language: 'Solidity', sources, settings: { evmVersion: 'istanbul', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  return JSON.parse(solc.compile(JSON.stringify(input)));
}
function solidityResult(output, start) {
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  const artifacts = [];
  for (const src of Object.keys(output.contracts || {})) for (const name of Object.keys(output.contracts[src])) {
    const c = output.contracts[src][name];
    artifacts.push({ path: `${name}.abi`, content: JSON.stringify(c.abi) });
    artifacts.push({ path: `${name}.bin`, content: (c.evm && c.evm.bytecode && c.evm.bytecode.object) || '' });
  }
  return { exitCode: errors.length ? 1 : 0, stdout: JSON.stringify({ warnings: (output.errors || []).filter(e => e.severity !== 'error') }), stderr: errors.map(e => e.formattedMessage || e.message).join('\n'), artifacts, durationMs: Date.now() - start };
}

// ---------- v1 sync endpoint ----------
async function handleSync(req, res) {
  let p; try { p = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
  const { files = [], command, args = [], timeoutSec = 30, runtime = 'shell' } = p;
  const cap = Math.min(Math.max(Number(timeoutSec) || 30, 1), 60);
  const start = Date.now();
  if (runtime === 'solidity') {
    try { return send(res, 200, solidityResult(await compileSolidity(files), start)); }
    catch (e) { return send(res, 200, { exitCode: 1, stdout: '', stderr: String((e && e.message) || e), artifacts: [], durationMs: Date.now() - start }); }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-'));
  try {
    writeFiles(dir, files);
    const [exe, exeArgs] = runtime === 'node' ? ['node', args] : ['sh', ['-c', [command, ...args].join(' ')]];
    execFile(exe, exeArgs, { cwd: dir, timeout: cap * 1000, maxBuffer: 10 * 1024 * 1024, env: childEnv({}) }, (err, stdout, stderr) => {
      const inputs = new Set(files.map(f => f.path)); const artifacts = [];
      try { for (const n of fs.readdirSync(dir)) if (!inputs.has(n) && /\.(abi|bin|json)$/.test(n)) artifacts.push({ path: n, content: fs.readFileSync(path.join(dir, n), 'utf8') }); } catch {}
      send(res, 200, { exitCode: err ? (err.killed ? 124 : (err.code ?? 1)) : 0, stdout: redact((stdout || '').slice(0, 200000)), stderr: redact((stderr || '').slice(0, 200000)), artifacts, durationMs: Date.now() - start });
      fs.rmSync(dir, { recursive: true, force: true });
    });
  } catch (e) { send(res, 500, { exitCode: 1, stdout: '', stderr: String(e), artifacts: [], durationMs: Date.now() - start }); fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---------- background jobs ----------
const jobs = new Map(); // id -> job
const queue = [];
let running = 0;

function childEnv(extra) {
  // Jobs get a clean env: PATH/HOME plus the Theta key for review calls. Never the runner auth token.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME || '/root', LANG: 'C.UTF-8', NODE_PATH: '/usr/local/lib/node_modules', CHROME_PATH: process.env.CHROME_PATH || '' };
  if (process.env.THETA_ONDEMAND_KEY) env.THETA_ONDEMAND_KEY = process.env.THETA_ONDEMAND_KEY;
  for (const [k, v] of Object.entries(extra || {})) if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !['RUNNER_AUTH_TOKEN', 'THETA_ONDEMAND_KEY'].includes(k)) env[k] = String(v);
  return env;
}
function publicJob(j, withLog = true) {
  const o = { id: j.id, status: j.status, runtime: j.runtime, label: j.label, workspace: j.workspace || null, createdAt: j.createdAt, startedAt: j.startedAt || null, endedAt: j.endedAt || null, durationMs: j.startedAt ? ((j.endedAt || Date.now()) - j.startedAt) : 0, exitCode: j.exitCode ?? null, error: j.error || null, logBytes: j.logBytes };
  if (withLog) { o.logTail = redact(readLog(j, Math.max(0, j.logBytes - 8000))); o.artifacts = listArtifacts(j); }
  return o;
}
function readLog(j, from) { try { const fd = fs.openSync(j.logPath, 'r'); const len = Math.max(0, j.logBytes - from); const b = Buffer.alloc(Math.min(len, 1024 * 1024)); fs.readSync(fd, b, 0, b.length, from); fs.closeSync(fd); return b.toString('utf8'); } catch { return ''; } }
function listArtifacts(j) {
  const out = []; const base = j.outDir;
  const walk = (d, depth) => { if (depth > 3) return; for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) { if (n.name !== 'node_modules') walk(p, depth + 1); } else out.push({ path: path.relative(base, p), bytes: fs.statSync(p).size }); if (out.length > 200) return; } };
  try { walk(base, 0); } catch {}
  return out;
}
function appendLog(j, chunk) {
  if (j.logBytes >= LOG_CAP) return;
  const s = chunk.slice(0, LOG_CAP - j.logBytes);
  fs.appendFileSync(j.logPath, s); j.logBytes += s.length;
}
function saveMeta(j) { try { fs.writeFileSync(path.join(j.dir, 'job.json'), JSON.stringify(publicJob(j, false))); } catch {} }

function createJob(p) {
  const runtime = p.runtime || 'shell';
  if (!['shell', 'node', 'solidity', 'browser-bench', 'review', 'checks'].includes(runtime)) throw new Error('unknown runtime');
  const id = 'job_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const dir = path.join(JOBS_DIR, id); fs.mkdirSync(dir, { recursive: true });
  let cwd = path.join(dir, 'work');
  if (p.workspace) {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.workspace)) throw new Error('workspace must be lowercase letters, digits, dashes');
    cwd = path.join(WS_DIR, p.workspace);
  }
  fs.mkdirSync(cwd, { recursive: true });
  try {
    writeFiles(cwd, p.files);
    // Chain jobs: copy another job's output files in, e.g. review a finished browser-bench run.
    if (p.fromJob) {
      const src = jobs.get(String(p.fromJob));
      if (!src || !src.endedAt) throw new Error('fromJob must be a finished job');
      for (const name of [].concat(p.fromFiles || ['results.json'])) {
        const from = safeJoin(src.outDir, name); if (fs.existsSync(from)) fs.copyFileSync(from, safeJoin(cwd, path.basename(name)));
      }
    }
  } catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw e; }
  const j = { id, runtime, label: String(p.label || '').slice(0, 80), workspace: p.workspace || null, dir, cwd, outDir: cwd, logPath: path.join(dir, 'log.txt'), logBytes: 0, createdAt: Date.now(), status: 'queued', command: p.command, args: p.args || [], env: p.env || {}, timeoutSec: Math.min(Math.max(Number(p.timeoutSec) || 600, 1), MAX_JOB_SEC), files: p.files || [], options: p.options || {} };
  fs.writeFileSync(j.logPath, '');
  jobs.set(id, j); queue.push(j); saveMeta(j); pump();
  return j;
}
function pump() {
  while (running < MAX_CONCURRENT && queue.length) { const j = queue.shift(); if (j.status === 'queued') startJob(j); }
}
function finish(j, code, error) {
  if (j.endedAt) return;
  clearTimeout(j.timer);
  j.endedAt = Date.now(); j.exitCode = code; j.error = error || null;
  j.status = j.status === 'cancelled' ? 'cancelled' : (code === 0 ? 'succeeded' : (code === 124 ? 'timed_out' : 'failed'));
  appendLog(j, `\n[runner] ${j.status} exit=${code} after ${((j.endedAt - j.startedAt) / 1000).toFixed(1)}s\n`);
  running--; saveMeta(j); pump();
}
async function startJob(j) {
  running++; j.status = 'running'; j.startedAt = Date.now(); saveMeta(j);
  if (j.runtime === 'solidity') {
    try { const r = solidityResult(await compileSolidity(j.files), j.startedAt); for (const a of r.artifacts) fs.writeFileSync(path.join(j.cwd, a.path), a.content); appendLog(j, r.stderr || 'compiled\n'); finish(j, r.exitCode); }
    catch (e) { appendLog(j, String(e)); finish(j, 1, 'compile failed'); }
    return;
  }
  let exe, exeArgs;
  if (j.runtime === 'node') { exe = 'node'; exeArgs = j.args; }
  else if (j.runtime === 'browser-bench') { exe = 'node'; exeArgs = ['/runner/tools/browser-bench.js', JSON.stringify(j.options)]; }
  else if (j.runtime === 'review') { exe = 'node'; exeArgs = ['/runner/tools/review.js', JSON.stringify(j.options)]; }
  else if (j.runtime === 'checks') {
    // Built-in suites live in /runner/suites; a job can also upload its own suite.json.
    const o = { ...j.options };
    if (typeof o.suite === 'string' && !fs.existsSync(path.join(j.cwd, o.suite)) && /^[a-z0-9-]+$/.test(o.suite)) o.suite = `/runner/suites/${o.suite}.json`;
    exe = 'node'; exeArgs = ['/runner/tools/checks.js', JSON.stringify(o)];
  }
  else { exe = 'sh'; exeArgs = ['-c', [j.command, ...j.args].join(' ')]; }
  const child = spawn(exe, exeArgs, { cwd: j.cwd, env: childEnv(j.env), detached: true });
  j.child = child;
  child.stdout.on('data', d => appendLog(j, d.toString('utf8')));
  child.stderr.on('data', d => appendLog(j, d.toString('utf8')));
  j.timer = setTimeout(() => { appendLog(j, `\n[runner] timeout ${j.timeoutSec}s, killing\n`); try { process.kill(-child.pid, 'SIGKILL'); } catch {} j.timedOut = true; }, j.timeoutSec * 1000);
  child.on('error', e => finish(j, 1, String(e.message || e)));
  child.on('close', code => finish(j, j.timedOut ? 124 : (code ?? 1)));
}
function cancelJob(j) {
  if (j.status === 'queued') { j.status = 'cancelled'; j.startedAt = j.startedAt || Date.now(); j.endedAt = Date.now(); saveMeta(j); return; }
  if (j.status === 'running' && j.child) { j.status = 'cancelled'; try { process.kill(-j.child.pid, 'SIGKILL'); } catch {} }
}
// Keep the newest 200 jobs on disk.
setInterval(() => {
  const done = [...jobs.values()].filter(j => j.endedAt).sort((a, b) => b.endedAt - a.endedAt);
  for (const j of done.slice(200)) { fs.rmSync(j.dir, { recursive: true, force: true }); jobs.delete(j.id); }
}, 10 * 60 * 1000).unref();

function chromePath() { return process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => fs.existsSync(p)) || null; }

// ---------- router ----------
http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/health') {
      return send(res, 200, { ok: true, version: VERSION, chrome: !!chromePath(), thetaReview: !!process.env.THETA_ONDEMAND_KEY, running, queued: queue.length, cpus: os.cpus().length, memMB: Math.round(os.totalmem() / 1048576), freeMB: Math.round(os.freemem() / 1048576) });
    }
    if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && (u.pathname === '/' || u.pathname === '')) return handleSync(req, res);
    if (u.pathname === '/jobs' && req.method === 'POST') {
      let p; try { p = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'bad json' }); }
      try { const j = createJob(p); return send(res, 202, { jobId: j.id, status: j.status }); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
    }
    if (u.pathname === '/jobs' && req.method === 'GET') return send(res, 200, { jobs: [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map(j => publicJob(j, false)) });
    const m = u.pathname.match(/^\/jobs\/(job_[a-z0-9]+)(\/log|\/file)?$/);
    if (m) {
      const j = jobs.get(m[1]); if (!j) return send(res, 404, { error: 'no such job' });
      if (req.method === 'DELETE' && !m[2]) { cancelJob(j); return send(res, 200, publicJob(j)); }
      if (req.method === 'GET' && !m[2]) return send(res, 200, publicJob(j));
      if (req.method === 'GET' && m[2] === '/log') { const from = Math.max(0, Number(u.searchParams.get('from')) || 0); return send(res, 200, { from, to: j.logBytes, text: redact(readLog(j, from)), status: j.status }); }
      if (req.method === 'GET' && m[2] === '/file') {
        let fp; try { fp = safeJoin(j.outDir, u.searchParams.get('path')); } catch (e) { return send(res, 400, { error: e.message }); }
        if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) return send(res, 404, { error: 'no such file' });
        if (fs.statSync(fp).size > 20 * 1024 * 1024) return send(res, 413, { error: 'file over 20 MB' });
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return fs.createReadStream(fp).pipe(res);
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) { return send(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, () => console.log(`wave runner ${VERSION} on ${PORT}, chrome=${!!chromePath()}`));
