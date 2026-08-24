// verify-one.mjs — 区分度回归验证器（code_repair / sandbox），输出完整 axis
import { codeRepairEvaluator, sandboxEvaluator } from './packages/core/dist/index.js';
import { readFileSync } from 'node:fs';
const [id, correctPath, cheatPath] = process.argv.slice(2);
const arr = (await (await fetch('http://127.0.0.1:3001/api/scenarios')).json()).data;
const sc = arr.find((s) => s.id === id);
if (!sc) { console.log(JSON.stringify({ error: 'NOT_FOUND', id })); process.exit(0); }
const correct = correctPath ? readFileSync(correctPath, 'utf8') : null;
const cheat = cheatPath ? readFileSync(cheatPath, 'utf8') : null;
const EVAL = { code_repair: codeRepairEvaluator, sandbox: sandboxEvaluator };
const ev = EVAL[sc.grader];
if (!ev) { console.log(JSON.stringify({ error: 'NO_EVAL', id, grader: sc.grader })); process.exit(0); }
const lang = (sc.language || '').toLowerCase();
function wrap(s) {
  if (sc.grader === 'sandbox') return '\`\`\`sql\n' + s + '\n\`\`\`';
  return '\`\`\`' + lang + '\n' + s + '\n\`\`\`';
}
async function score(s) {
  try {
    const r = await ev.evaluate(sc, wrap(s), {}, undefined);
    return { total: Math.round(r.totalScore || 0), axes: r.axisScores || {} };
  } catch (e) { return { total: null, err: String(e?.message || e).slice(0, 80) }; }
}
const buggy = sc.sourceCode || '';
const out = { id, grader: sc.grader, buggy: await score(buggy), correct: correct != null ? await score(correct) : null, cheat: cheat != null ? await score(cheat) : null };
console.log(JSON.stringify(out));
