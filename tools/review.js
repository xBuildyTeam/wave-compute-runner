// Sends review prompts to a large model on Theta EdgeCloud's on-demand API (key stays in the container env).
// options:
//   { mode: 'bench', input: 'results.json', model?: 'qwen3_8_max' }  -> grades every benchmark answer, writes review.json
//   { mode: 'chat', requests: [{ id, messages, max_tokens? }], model? } -> writes responses.json
// Every response records Theta's own usage and cost_usd so spend is measured, not estimated.
const fs = require('fs');
const opt = JSON.parse(process.argv[2] || '{}');
const MODELS = { qwen3_8_max: 'qwen3.8-max', qwen3_8_flash: 'qwen3.8-flash' };
const alias = opt.model || 'qwen3_8_flash';
if (!MODELS[alias]) { console.error('model must be one of', Object.keys(MODELS).join(', ')); process.exit(2); }
const KEY = process.env.THETA_ONDEMAND_KEY;
if (!KEY) { console.error('THETA_ONDEMAND_KEY is not set on the runner'); process.exit(2); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(messages, max_tokens = 400) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    try {
      const r = await fetch(`https://ondemand.thetaedgecloud.com/infer_request/${alias}/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: { model: MODELS[alias], messages, max_tokens, stream: false, temperature: 0 } }),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json();
      const q = j.body && j.body.infer_requests && j.body.infer_requests[0];
      if (q && q.state === 'success') {
        const cost = q.cost_usd ? (Number(q.cost_usd.input) || 0) + (Number(q.cost_usd.output) || 0) : null;
        return { ok: true, text: q.output && q.output.message, usage: q.usage, cost_usd: cost, ms: Date.now() - t0 };
      }
      console.log(`attempt ${attempt}: ${r.status} ${(q && (q.error_message || q.state)) || JSON.stringify(j).slice(0, 200)}`);
    } catch (e) { console.log(`attempt ${attempt}: ${e.message}`); }
    await sleep(2000 * attempt);
  }
  return { ok: false };
}
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
const parseJSON = s => { try { return JSON.parse(String(s).replace(/^[\s\S]*?(\{[\s\S]*\})[\s\S]*$/, '$1')); } catch { return null; } };

const PROMPTS = {
  math: 'A shop sells pens at 3 for $2. How much do 12 pens cost? Answer with the number only.',
  date: 'If today is Monday, what day is it 10 days from now? Answer with the day only.',
  json: 'Return only JSON, no other text: {"tool":"search","query":"..."} to search for "Theta EdgeCloud pricing".',
  fact: 'In two sentences, what is a blockchain?',
  sum: 'Summarize in 10 words or fewer: Local AI runs on your own device, so it works offline, keeps data private and costs nothing per question.',
};
// Known reference answers. Graders are far more reliable when told the right answer.
const REFERENCE = {
  math: '$8 (12 pens = 4 groups of 3, 4 x $2)',
  date: 'Thursday',
  json: '{"tool":"search","query":"Theta EdgeCloud pricing"} with no other text',
};
const RUBRIC = `You grade answers from a small on-device AI model. Be strict and literal.
Score 1-5: 5 = fully correct and follows the format instruction, 4 = correct with a minor format slip, 3 = partly correct, 2 = mostly wrong, 1 = wrong, refused, or rambling/repetitive.
"correct" is true only if the core answer matches the reference answer when one is given (an answer that is cut off before stating the result is not correct). "followed_format" is true only if it obeyed length/format limits.
Reply with JSON only: {"score":n,"correct":bool,"followed_format":bool,"issue":"one short sentence or empty"}`;

(async () => {
  let total = 0, calls = 0, failed = 0;
  if (opt.mode === 'chat') {
    const res = await pool(opt.requests || [], 3, async rq => { const a = await ask(rq.messages, rq.max_tokens || 800); calls++; if (a.ok) total += a.cost_usd || 0; else failed++; return { id: rq.id, ...a }; });
    fs.writeFileSync('responses.json', JSON.stringify({ model: alias, calls, failed, cost_usd: +total.toFixed(6), responses: res }, null, 2));
    console.log(`done: ${calls} calls, ${failed} failed, cost $${total.toFixed(4)} (Theta reported)`);
    process.exit(failed === calls && calls ? 1 : 0);
  }
  const bench = JSON.parse(fs.readFileSync(opt.input || 'results.json', 'utf8'));
  const items = [];
  for (const run of bench.runs || []) for (const r of run.results || []) items.push({ run, r });
  console.log(`grading ${items.length} answers with ${alias}`);
  const graded = await pool(items, 3, async ({ run, r }) => {
    const q = PROMPTS[r.id] || r.prompt || r.id;
    const a = await ask([{ role: 'system', content: RUBRIC }, { role: 'user', content: `QUESTION:\n${q}\n\n${REFERENCE[r.id] ? `REFERENCE ANSWER (ground truth):\n${REFERENCE[r.id]}\n\n` : ''}ANSWER TO GRADE:\n${r.output || '(empty)'}` }], 120);
    calls++; if (!a.ok) { failed++; return { model: run.model, engine: run.engine, id: r.id, grade: null }; }
    total += a.cost_usd || 0;
    const grade = parseJSON(a.text);
    return { model: run.model, engine: run.engine, id: r.id, grade, raw: grade ? undefined : a.text, cost_usd: a.cost_usd, ms: a.ms };
  });
  const byModel = {};
  for (const g of graded) {
    const k = `${g.model} (${g.engine})`; const m = byModel[k] = byModel[k] || { answers: 0, graded: 0, scoreSum: 0, correct: 0, followed_format: 0 };
    m.answers++; if (g.grade && typeof g.grade.score === 'number') { m.graded++; m.scoreSum += g.grade.score; if (g.grade.correct) m.correct++; if (g.grade.followed_format) m.followed_format++; }
  }
  const summary = Object.entries(byModel).map(([k, m]) => ({ model: k, avg_score: m.graded ? +(m.scoreSum / m.graded).toFixed(2) : null, correct: `${m.correct} of ${m.graded}`, followed_format: `${m.followed_format} of ${m.graded}`, ungraded: m.answers - m.graded }));
  fs.writeFileSync('review.json', JSON.stringify({ grader: alias, calls, failed, cost_usd: +total.toFixed(6), summary, graded }, null, 2));
  for (const s of summary) console.log(`REVIEW ${s.model}: avg ${s.avg_score}/5, correct ${s.correct}, format ${s.followed_format}`);
  console.log(`cost $${total.toFixed(4)} over ${calls} calls (Theta reported), ${failed} failed`);
  process.exit(failed === calls && calls ? 1 : 0);
})();
