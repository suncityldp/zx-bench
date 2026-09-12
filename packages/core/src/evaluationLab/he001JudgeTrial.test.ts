import {readFileSync} from 'node:fs';
import {describe,it,expect,vi} from 'vitest';
import {he001ProtocolFixtures} from './he001ProtocolFixtures.js';
import {parseHE001Judgment,parseHE001JudgmentWithLineBreaks,resolveHE001LineBreakSpan,postHE001Once} from './he001JudgeTrial.js';
const schema=JSON.parse(readFileSync(new URL('./fixtures/he001-v3-schema.json',import.meta.url),'utf8'));
const f=he001ProtocolFixtures()[0];
describe('bounded HE-001 Judge trial contract',()=>{
  it('restores only CR/LF changes to the actual original span with provenance',()=>{
    const r=structuredClone(f.review);r.verification.quote=r.verification.quote!.replace(/[\r\n]/g,'');
    expect(()=>parseHE001Judgment(f.answer,JSON.stringify(r),'stop',schema)).toThrow();
    const parsed=parseHE001JudgmentWithLineBreaks(f.answer,JSON.stringify(r),'stop',schema);
    expect(parsed.strictValidationPassed).toBe(false);expect(parsed.lineBreakResolutions).toHaveLength(1);
    expect(parsed.review).toEqual(f.review);expect(parsed.profile).toEqual(parseHE001Judgment(f.answer,JSON.stringify(f.review),'stop',schema).profile);
    const span=parsed.lineBreakResolutions[0];expect(f.answer.slice(span.start,span.end)).toBe(span.resolvedQuote);
  });
  it('does not change already valid results or the supplied labels',()=>{
    for(const x of he001ProtocolFixtures()){
      const parsed=parseHE001JudgmentWithLineBreaks(x.answer,JSON.stringify(x.review),'stop',schema);
      expect(parsed.strictValidationPassed).toBe(true);expect(parsed.lineBreakResolutions).toEqual([]);expect(parsed.review).toEqual(x.review);
    }
  });
  it.each(['甲乙','甲\t乙','甲\n乙','甲 乙!'])('rejects non-newline edits: %s',quote=>{
    expect(()=>resolveHE001LineBreakSpan('甲 乙。',quote)).toThrow();
  });
  it('rejects changed negation, numbers, punctuation, disjoint spans and ambiguity',()=>{
    for(const [answer,quote]of [['每轮均未停机。','每轮均停机。'],['82℃','83℃'],['甲，乙','甲乙'],['甲中间有话乙','甲乙'],['甲\n乙；甲\n\n乙','甲乙']])expect(()=>resolveHE001LineBreakSpan(answer,quote)).toThrow();
  });
  it('keeps the prior observed JC-003 failure immutable while reproducing its newline diagnosis',()=>{
    const raw=JSON.parse(readFileSync(new URL('./fixtures/he001-v3-jc003-raw.json',import.meta.url),'utf8'));
    const packet=JSON.parse(readFileSync(new URL('./fixtures/he001-v3-packet.json',import.meta.url),'utf8'));
    const before=raw.content;expect(()=>parseHE001Judgment(packet.items[2].answer,raw.content,raw.finishReason,schema)).toThrow();
    expect(parseHE001JudgmentWithLineBreaks(packet.items[2].answer,raw.content,raw.finishReason,schema).lineBreakResolutions).toHaveLength(1);
    expect(raw.content).toBe(before);
  });
  it('validates all author fixtures against the actual frozen schema',()=>{
    for(const x of he001ProtocolFixtures())expect(parseHE001Judgment(x.answer,JSON.stringify(x.review),'stop',schema).profile.productionEligible).toBe(false);
  });
  it('rejects code fences, extra fields, truncation, and fabricated spans',()=>{
    expect(()=>parseHE001Judgment(f.answer,'```json\n'+JSON.stringify(f.review)+'\n```','stop',schema)).toThrow();
    expect(()=>parseHE001Judgment(f.answer,JSON.stringify({...f.review,extra:true}),'stop',schema)).toThrow('extra');
    expect(()=>parseHE001Judgment(f.answer,JSON.stringify(f.review),'length',schema)).toThrow('truncated');
    const r=structuredClone(f.review);r.claims[0].quote='not an original quote';
    expect(()=>parseHE001Judgment(f.answer,JSON.stringify(r),'stop',schema)).toThrow();
  });
  it('never retries stream-options HTTP errors or switches model',async()=>{
    const request=vi.fn(async()=>new Response('stream_options not supported',{status:400}));
    expect((await postHE001Once('https://example.invalid','fake-key',{model:'frozen-model'},new AbortController().signal,request as typeof fetch)).status).toBe(400);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not send a cancelled call',async()=>{
    const c=new AbortController();c.abort();const request=vi.fn();
    await expect(postHE001Once('https://example.invalid','fake-key',{},c.signal,request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
