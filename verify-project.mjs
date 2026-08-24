// verify-project.mjs — project_repair 多文件区分度回归验证器
import { projectRepairEvaluator } from './packages/core/dist/index.js';
import { readFileSync } from 'node:fs';
const [id, correctPath, cheatPath] = process.argv.slice(2);
const arr = (await (await fetch('http://127.0.0.1:3001/api/scenarios')).json()).data;
const sc = arr.find((s) => s.id === id);
if (!sc) { console.log(JSON.stringify({ error: 'NOT_FOUND', id })); process.exit(0); }
const correct = correctPath ? readFileSync(correctPath, 'utf8') : null;
const cheat = cheatPath ? readFileSync(cheatPath, 'utf8') : null;
async function score(s) {
  try {
    const r = await projectRepairEvaluator.evaluate(sc, s, {}, undefined);
    return { total: Math.round(r.totalScore || 0), axes: r.axisScores || {} };
  } catch (e) { return { total: null, err: String(e?.message || e).slice(0, 140) }; }
}
// buggy = 空输出（无替换 → 用初始 buggy 工作区）
const out = { id, grader: sc.grader, buggy: await score(''), correct: correct != null ? await score(correct) : null, cheat: cheat != null ? await score(cheat) : null };
console.log(JSON.stringify(out));
