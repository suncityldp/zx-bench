import {readFileSync} from 'node:fs';
import {it,expect} from 'vitest';
import {parseHE001V4Micro} from './he001V4MicroTrial.js';
const packet=JSON.parse(readFileSync(new URL('./fixtures/he001-v4-micro-control.json',import.meta.url),'utf8'));
const source=packet.items[0].source;
const review={label:'unsupported',quote:source,relation:'context',reason:'只有提供的记录。'};
it('checks micro JSON and literal source span without claiming semantic calibration',()=>{
 expect(parseHE001V4Micro(source,JSON.stringify(review),'stop',packet.schema)).toMatchObject({structureAndSpanChecked:true,evidenceEntailmentChecked:false,productionEligible:false});
});
it('rejects malformed, truncated, conflicting, extra-field and fabricated micro output',()=>{
 for(const r of [{...review,quote:'根本不存在的原句'},{...review,relation:'contradicts'},{...review,extra:true},{...review,reason:'长'.repeat(241)}])expect(()=>parseHE001V4Micro(source,JSON.stringify(r),'stop',packet.schema)).toThrow();
 expect(()=>parseHE001V4Micro(source,JSON.stringify(review),'length',packet.schema)).toThrow();
 expect(()=>parseHE001V4Micro(source,'not JSON','stop',packet.schema)).toThrow();
});
