// Runs the Wave Lite AI benchmark page in headless Chromium and writes results.json.
// options: { html?: path to page (default /runner/bench/index.html), models: [index,...], engine: 'wasm'|'webgpu'|'auto', perModelTimeoutSec?: 1800 }
// The page is served locally with COOP/COEP so the CPU path runs multi-threaded.
// The Chrome profile lives in /workspace/chrome-profile so downloaded models stay cached between jobs.
const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const opt = JSON.parse(process.argv[2] || '{}');
const html = path.resolve(opt.html || '/runner/bench/index.html');
const models = (opt.models && opt.models.length) ? opt.models : [2];
const engine = opt.engine || 'wasm';
const perModelMs = Math.min(Number(opt.perModelTimeoutSec) || 1800, 3600) * 1000;
const profile = process.env.BENCH_PROFILE || path.join(process.env.RUNNER_DATA_DIR || '/workspace', 'chrome-profile');
const chrome = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  if (!chrome) throw new Error('no chromium found');
  const page = fs.readFileSync(html);
  const srv = http.createServer((q, s) => { s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'credentialless' }); s.end(page); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const port = 9300 + Math.floor(Math.random() * 500);
  const flags = ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`];
  if (engine === 'webgpu') flags.push('--enable-unsafe-webgpu', '--enable-features=Vulkan');
  const c = spawn(chrome, [...flags, 'about:blank'], { stdio: 'ignore' });
  let list; for (let i = 0; i < 40; i++) { await sleep(500); try { list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (list.find(t => t.type === 'page')) break; } catch {} }
  const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = (m, p = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) pend[m.id](m.result); if (m.method === 'Runtime.exceptionThrown') log('page error', JSON.stringify(m.params.exceptionDetails).slice(0, 300)); };
  await new Promise(r => ws.onopen = r);
  await send('Runtime.enable'); await send('Page.enable');
  const ev = async e => ((await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result || {}).value;
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) { await sleep(1000); if (await ev("document.getElementById('model') && document.getElementById('model').options.length")) break; }
  const device = await ev("JSON.stringify({ua:navigator.userAgent,cores:navigator.hardwareConcurrency,isolated:self.crossOriginIsolated,webgpu:!!navigator.gpu})");
  log('device', device);
  const before = JSON.parse(await ev("localStorage.getItem('waveLiteBench')||'[]'")).length;
  const outcomes = [];
  for (const mi of models) {
    const name = await ev(`document.getElementById('model').options[${Number(mi)}]?.textContent || ''`);
    log('model', mi, name, engine);
    await ev(`document.getElementById('model').value=${Number(mi)};document.getElementById('engine').value=${JSON.stringify(engine)};document.getElementById('run').click();1`);
    const t0 = Date.now(); let last = '', status = '';
    while (Date.now() - t0 < perModelMs) {
      await sleep(5000);
      status = await ev("document.getElementById('status').textContent") || '';
      if (status !== last) { log(status); last = status; }
      if (/^Done|Could not|no WebGPU|needs WebGPU/.test(status)) break;
    }
    outcomes.push({ index: mi, name, status });
    if (!/^Done/.test(status)) { log('model did not finish:', status); await send('Page.reload'); await sleep(6000); }
  }
  const runs = JSON.parse(await ev("localStorage.getItem('waveLiteBench')||'[]'")).slice(before);
  fs.writeFileSync('results.json', JSON.stringify({ tool: 'wave-lite-ai-bench/1', device: JSON.parse(device), engine, outcomes, runs }, null, 2));
  for (const r of runs) log(`RESULT ${r.model} ${r.engine}: load ${(r.load_ms / 1000).toFixed(1)}s, first token ${r.avg_ttft_ms} ms, ${r.avg_decode_tps} tok/s, checks ${r.correct}`);
  try { c.kill(); } catch {} srv.close();
  process.exit(runs.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
