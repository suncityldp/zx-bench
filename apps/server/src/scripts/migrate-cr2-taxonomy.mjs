
// CR2 pack taxonomy 统一：dimension=code_repair → program；grader=code_repair_v3 → code_repair；
// graderVersion 3.0.0 → 3.2.0；scenarioHash 空 → 用 canonicalize 回填。
import { readFileSync, writeFileSync } from 'node:fs';
import { hashScenarioShort } from '@zxbench/core';

const files = ['cr2-c-rust-sql.json','cr2-java-go.json','cr2-js-ts.json','cr2-others.json','cr2-python.json'];
const BASE = 'J:/AI/zxbench-webui/data/scenarios/';
let total = 0;
for (const fn of files) {
  const arr = JSON.parse(readFileSync(BASE + fn, 'utf8'));
  for (const s of arr) {
    s.dimension = 'program';
    s.grader = 'code_repair';
    s.graderVersion = '3.2.0';
    s.scenarioHash = hashScenarioShort(s);
    total++;
  }
  writeFileSync(BASE + fn, JSON.stringify(arr, null, 1), 'utf8');
  console.log(fn + ': migrated ' + arr.length + ' (hash=' + arr[0].scenarioHash + ')');
}
console.log('TOTAL migrated:', total);
