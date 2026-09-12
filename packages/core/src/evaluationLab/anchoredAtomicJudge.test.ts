import {describe,it,expect} from 'vitest';
import {candidateSegments,anchoredJudgeFixtures,anchoredPublicItem,parseAnchoredAudit} from './anchoredAtomicJudge.js';
describe('fixed source anchors avoid paraphrased quote repair',()=>{
  const item=anchoredJudgeFixtures()[0].item;
  const response=[{id:item.id,verdict:'pass',segments:['C1'],sources:[Object.keys(item.sources)[0]],reason:'测试理由。'}];
  it('preserves every original byte-equivalent JS substring and exact offsets',()=>{
    const text='有人说“错误。”但这说法应撤回。\r\n条件句！尾句';const segments=candidateSegments(text);
    expect(segments.map(s=>s.text).join('')).toBe(text);for(const s of segments)expect(text.slice(s.start,s.end)).toBe(s.text);
  });
  it('resolves Judge references without manufacturing or joining original quotations',()=>{
    const parsed=parseAnchoredAudit([item],JSON.stringify(response),'stop',true)[0];
    expect(parsed.quote).toBe(item.candidate);expect(parsed.quoteOrigin).toBe('host_original_candidate_context');
    expect(parsed.resolvedSegments[0]).toEqual(candidateSegments(item.candidate)[0]);
    expect(anchoredPublicItem(item).candidateSegments).toEqual(candidateSegments(item.candidate));
  });
  it('rejects invented anchors, duplicated refs, old quote fields and nonterminal output',()=>{
    const wrong=structuredClone(response);wrong[0].segments=['C999'];expect(()=>parseAnchoredAudit([item],JSON.stringify(wrong),'stop',true)).toThrow();
    wrong[0].segments=['C1','C1'];expect(()=>parseAnchoredAudit([item],JSON.stringify(wrong),'stop',true)).toThrow();
    expect(()=>parseAnchoredAudit([item],JSON.stringify([{...response[0],quote:'省略……'}]),'stop',true)).toThrow();
    expect(()=>parseAnchoredAudit([item],JSON.stringify(response),'length',true)).toThrow();
  });
});
