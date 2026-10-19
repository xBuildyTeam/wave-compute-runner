// Wave checks: one runner job that tests bots, on-chain models, Theta LLMs and Wave services.
// options: { suite: "suite.json" (path in job dir) | suiteObject, compareTo?: "previous-report.json", grader?: "qwen3_8_flash" }
// Writes report.json, report.md and training-failures.jsonl (every failed answer with its reference,
// ready to turn into fine-tuning or knowledge-card fixes).
// Check types: http, card, tns, botchat, llm, eth_call. Every number in the report is measured in this run.
const fs = require('fs');
const crypto = require('crypto');
const opt = JSON.parse(process.argv[2] || '{}');
const suite = typeof opt.suite === 'object' ? opt.suite : JSON.parse(fs.readFileSync(opt.suite || 'suite.json', 'utf8'));
const GRADER = opt.grader || suite.grader || 'qwen3_8_flash';
const MODELS = { qwen3_8_max: 'qwen3.8-max', qwen3_8_flash: 'qwen3.8-flash', glm_5_3_flash: 'glm-5.3-flash', glm_5_3: 'glm-5.3' };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KEY = process.env.THETA_ONDEMAND_KEY;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let spend = 0;
const training = [];

async function timed(fn) { const t = Date.now(); try { return { ...(await fn()), ms: Date.now() - t }; } catch (e) { return { error: String(e.message || e), ms: Date.now() - t }; } }
async function req(url, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
  const r = await fetch(url, { method, headers: { 'user-agent': UA, ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}
const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? v : v[k]), o);

async function theta(alias, messages, max_tokens = 300) {
  if (!KEY) throw new Error('THETA_ONDEMAND_KEY not set');
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await req(`https://ondemand.thetaedgecloud.com/infer_request/${alias}/completions`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: { input: { model: MODELS[alias] || alias, messages, max_tokens, stream: false, temperature: 0 } }, timeoutMs: 120000 });
      const q = r.json && r.json.body && r.json.body.infer_requests && r.json.body.infer_requests[0];
      if (q && q.state === 'success') { const c = q.cost_usd ? (+q.cost_usd.input || 0) + (+q.cost_usd.output || 0) : 0; spend += c; return { text: String(q.output && q.output.message || ''), cost: c }; }
      log(`theta ${alias} attempt ${a}: ${r.status} ${(q && (q.error_message || q.state)) || r.text.slice(0, 120)}`);
    } catch (e) { log(`theta ${alias} attempt ${a}: ${e.message}`); }
    await sleep(1500 * a);
  }
  throw new Error(`${alias} gave no answer after 3 tries`);
}
const RUBRIC = `You check an answer against a reference answer (ground truth) and a list of known facts. Be strict but fair.
"correct" is true if the answer's key facts match the reference and nothing contradicts it.
"hallucination" is true ONLY if the answer states something that contradicts the reference or the known facts.
Extra details that are not in the reference are NOT hallucinations; list any specific ones you cannot confirm (numbers, addresses, names, versions) in "unverified".
Score 1-5. Reply with JSON only: {"score":n,"correct":bool,"hallucination":bool,"unverified":["..."],"issue":"one short sentence or empty"}`;
const FACTS = (suite.facts || []).map(f => '- ' + f).join('\n');
async function grade(question, reference, answer) {
  const r = await theta(GRADER, [{ role: 'system', content: RUBRIC }, { role: 'user', content: `QUESTION:\n${question}\n\nREFERENCE ANSWER:\n${reference}\n\n${FACTS ? `KNOWN FACTS:\n${FACTS}\n\n` : ''}ANSWER TO CHECK:\n${answer || '(empty)'}` }], 200);
  try { return JSON.parse(r.text.replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1')); } catch { return { score: null, correct: null, issue: 'grader reply was not JSON' }; }
}
const stripThink = s => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();

// ---------- check types ----------
const RUN = {
  // Repeat a request and require a success rate. expect: {status, json:{path:value}, contains}
  async http(c) {
    const n = c.repeat || 1, rows = [];
    for (let i = 0; i < n; i++) {
      const r = await timed(() => req(c.url, { method: c.method || (c.body ? 'POST' : 'GET'), body: c.body }));
      let ok = !r.error && r.status === (c.expect?.status ?? 200);
      if (ok && c.expect?.json) for (const [p, v] of Object.entries(c.expect.json)) if (get(r.json, p) !== v) ok = false;
      if (ok && c.expect?.contains && !r.text.includes(c.expect.contains)) ok = false;
      rows.push({ ok, status: r.status, ms: r.ms, error: ok ? undefined : (r.error || (r.json && (r.json.message || r.json.error)) || r.text?.slice(0, 160)) });
      if (c.gapMs) await sleep(c.gapMs);
    }
    const okN = rows.filter(r => r.ok).length, rate = okN / n, need = c.minSuccess ?? 1;
    const errors = [...new Set(rows.filter(r => !r.ok).map(r => String(r.error).slice(0, 160)))];
    return { status: rate >= need ? 'pass' : 'fail', summary: `${okN} of ${n} ok (need ${Math.round(need * 100)}%), median ${median(rows.map(r => r.ms))} ms`, errors, rows };
  },
  // A BrainVault card is live and readable (Wave Web check API).
  async card(c) {
    const r = await req(`https://web.oswave.io/functions/waveApi?action=check&ref=${encodeURIComponent(c.ref)}`);
    const j = r.json || {};
    const ok = j.live === true && (!c.kind || j.kind === c.kind);
    return { status: ok ? 'pass' : 'fail', summary: `${c.ref}: ${j.reason || r.status}${c.kind ? ` (kind ${j.kind})` : ''}`, detail: j.checks };
  },
  // A TNS text record equals the expected value.
  async tns(c) {
    const r = await req('https://web.oswave.io/functions/tnsInfo', { method: 'POST', body: { name: c.name } });
    if (r.status !== 200 || !r.json || !r.json.records) return { status: 'fail', summary: `could not read ${c.name}: HTTP ${r.status}`, errors: [String((r.json && (r.json.error || r.json.message)) || r.text.slice(0, 160))] };
    const got = r.json.records[c.record];
    return { status: got === c.equals ? 'pass' : 'fail', summary: `${c.name} ${c.record} = ${JSON.stringify(got)} (want ${JSON.stringify(c.equals)})`, owner: r.json.owner };
  },
  // Ask a live bot real questions, grade each answer against a reference with a Theta model.
  async botchat(c) {
    const url = c.endpoint || 'https://web.oswave.io/functions/botChat';
    const browserId = crypto.randomUUID();
    const rows = [];
    for (const q of c.questions) {
      // api "wave-web": the public path people use (name -> TNS -> listing -> bot). api "waveos": straight to the bot, skipping lookup.
      const body = c.api === 'waveos'
        ? { action: 'ask', bot_id: c.botId, browser_id: browserId, question: q.q, history: [] }
        : { action: 'chat', name: c.name, browserId, messages: [{ role: 'user', content: q.q }] };
      const r = await timed(() => req(c.api === 'waveos' ? (c.endpoint || 'https://app.oswave.io/functions/botPublicChat') : url, { method: 'POST', body, timeoutMs: 90000 }));
      const answer = r.json && (r.json.reply || r.json.answer || r.json.content || r.json.message);
      if (r.error || r.status !== 200 || !answer) { rows.push({ q: q.q, ok: false, reachable: false, ms: r.ms, error: r.error || (r.json && (r.json.error || r.json.message)) || `HTTP ${r.status}` }); continue; }
      const g = q.reference ? await grade(q.q, q.reference, answer) : null;
      const ok = g ? !!g.correct && !g.hallucination : true;
      rows.push({ q: q.q, ok, reachable: true, ms: r.ms, answer: answer.slice(0, 1200), grade: g });
      if (!ok) training.push({ source: `bot:${c.name}`, question: q.q, reference: q.reference, bad_answer: answer, grade: g });
    }
    const reach = rows.filter(r => r.reachable).length, good = rows.filter(r => r.ok).length;
    const errors = [...new Set(rows.filter(r => !r.reachable).map(r => String(r.error).slice(0, 160)))];
    const status = reach < rows.length ? 'fail' : good < rows.length ? 'warn' : 'pass';
    return { status, summary: `${reach} of ${rows.length} answered, ${good} correct, median ${median(rows.filter(r => r.reachable).map(r => r.ms))} ms`, errors, rows };
  },
  // Ask a Theta on-demand model reference questions (also used to compare models before training or wiring a bot).
  async llm(c) {
    const rows = [];
    for (const q of c.prompts) {
      const r = await timed(() => theta(c.model, [...(c.system ? [{ role: 'system', content: c.system }] : []), { role: 'user', content: q.q }], q.max_tokens || 300));
      if (r.error) { rows.push({ q: q.q, ok: false, error: r.error, ms: r.ms }); continue; }
      const answer = stripThink(r.text);
      let ok = true, g = null;
      if (q.contains) ok = answer.toLowerCase().includes(String(q.contains).toLowerCase());
      if (q.reference) { g = await grade(q.q, q.reference, answer); ok = ok && !!g.correct && !g.hallucination; }
      rows.push({ q: q.q, ok, ms: r.ms, cost_usd: r.cost, answer: answer.slice(0, 800), grade: g });
      if (!ok) training.push({ source: `llm:${c.model}`, question: q.q, reference: q.reference || q.contains, bad_answer: answer, grade: g });
    }
    const good = rows.filter(r => r.ok).length;
    return { status: good === rows.length ? 'pass' : (rows.some(r => r.error) ? 'fail' : 'warn'), summary: `${good} of ${rows.length} correct, median ${median(rows.map(r => r.ms))} ms, $${rows.reduce((s, r) => s + (r.cost_usd || 0), 0).toFixed(4)}`, rows };
  },
  // Call a view function on Theta. Determinism: the same input must give byte-identical output every time.
  async eth_call(c) {
    const { ethers } = require('ethers');
    const rpc = c.rpc || 'https://eth-rpc-api.thetatoken.org/rpc';
    const rows = [];
    for (const input of c.inputs) {
      const seed = input.seed || (input.text != null ? ethers.keccak256(ethers.toUtf8Bytes(String(input.text).trim().toLowerCase())) : input.name ? ethers.namehash(input.name) : null);
      const data = ethers.id(c.sig).slice(0, 10) + (seed ? seed.slice(2) : '');
      const outs = [];
      for (let i = 0; i < (c.repeat || 2); i++) {
        const r = await timed(() => req(rpc, { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: c.to, data, gas: c.gas || '0x1312d00' }, 'latest'] } }));
        outs.push({ ms: r.ms, result: r.json && r.json.result, error: r.error || (r.json && r.json.error && r.json.error.message) });
      }
      const res = outs.map(o => o.result);
      const okAll = outs.every(o => o.result && o.result.length > (c.minHexLen || 2));
      const same = res.every(x => x === res[0]);
      rows.push({ input, ok: okAll && same, bytes: res[0] ? (res[0].length - 2) / 2 : 0, deterministic: same, sha256: res[0] ? crypto.createHash('sha256').update(res[0]).digest('hex').slice(0, 16) : null, ms: outs.map(o => o.ms), error: outs.find(o => o.error)?.error });
    }
    const good = rows.filter(r => r.ok).length;
    return { status: good === rows.length ? 'pass' : 'fail', summary: `${good} of ${rows.length} inputs returned output and matched on every repeat`, rows };
  },
};
const median = a => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

(async () => {
  const started = new Date().toISOString();
  log(`suite ${suite.suite}: ${suite.checks.length} checks, grader ${GRADER}`);
  const results = [];
  for (const c of suite.checks) {
    log(`check ${c.id} (${c.type})`);
    const fn = RUN[c.type];
    const r = fn ? await timed(() => fn(c)) : { status: 'fail', summary: `unknown check type ${c.type}` };
    if (r.error) { r.status = 'fail'; r.summary = `check crashed: ${r.error}`; }
    results.push({ id: c.id, type: c.type, title: c.title || c.id, ...r });
    log(`  ${r.status.toUpperCase()} ${r.summary}`);
  }
  // Regression compare against an earlier report.
  let prev = null; try { if (opt.compareTo && fs.existsSync(opt.compareTo)) prev = JSON.parse(fs.readFileSync(opt.compareTo, 'utf8')); } catch {}
  for (const r of results) { const p = prev && prev.results.find(x => x.id === r.id); r.previous = p ? p.status : null; r.regressed = !!p && p.status === 'pass' && r.status !== 'pass'; r.fixed = !!p && p.status !== 'pass' && r.status === 'pass'; }
  const count = s => results.filter(r => r.status === s).length;
  const report = { tool: 'wave-checks/1', suite: suite.suite, started, finished: new Date().toISOString(), grader: GRADER, theta_spend_usd: +spend.toFixed(5), totals: { pass: count('pass'), warn: count('warn'), fail: count('fail') }, regressions: results.filter(r => r.regressed).map(r => r.id), fixed: results.filter(r => r.fixed).map(r => r.id), results };
  fs.writeFileSync('report.json', JSON.stringify(report, null, 2));
  fs.writeFileSync('training-failures.jsonl', training.map(t => JSON.stringify(t)).join('\n') + (training.length ? '\n' : ''));
  const md = [`# ${suite.suite} checks`, '', `${started.slice(0, 16).replace('T', ' ')} UTC · ${report.totals.pass} pass · ${report.totals.warn} warn · ${report.totals.fail} fail · Theta spend $${report.theta_spend_usd}`, '',
    ...(report.regressions.length ? [`**Regressions:** ${report.regressions.join(', ')}`, ''] : []),
    '| Check | Result | Details |', '|---|---|---|',
    ...results.map(r => `| ${r.title} | ${r.status.toUpperCase()}${r.regressed ? ' (regressed)' : r.fixed ? ' (fixed)' : ''} | ${String(r.summary).replace(/\|/g, '/')}${r.errors && r.errors.length ? `. Errors: ${r.errors.join('; ').replace(/\|/g, '/')}` : ''} |`),
    '', `${training.length} failed answers saved to training-failures.jsonl.`].join('\n');
  fs.writeFileSync('report.md', md + '\n');
  console.log('\n' + md);
  process.exit(report.totals.fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
