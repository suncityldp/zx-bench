import{describe,it,expect}from'vitest';
import{Script}from'node:vm';
import{buildJudgeFixtures}from'./qualification.js';
import{buildBlindPacket,renderBlindReview,validateHumanSubmission,type HumanReviewSubmission}from'./humanReview.js';
const {packet}=buildBlindPacket(buildJudgeFixtures());
const submission=():HumanReviewSubmission=>({version:1,packetHash:packet.hash,reviewer:'真人审核者',humanAttestation:true,reviews:packet.items.map(i=>({itemId:i.id,inputHash:i.inputHash,outcome:'usable',labels:Object.fromEntries(i.criteria.map(c=>[c.id,'pass'])),rationale:'此处仅为自动测试输入，并非真实人工审核',sourceEvidence:'测试来源，生产审核不得使用自动标签',sourceVerified:true}))});
describe('single-human blind review',()=>{
 it('omits Judge scores and fixture labels/identifiers',()=>{const text=JSON.stringify(packet);expect(packet.items).toHaveLength(44);expect(text).not.toContain('expected');expect(text).not.toContain('mutation');expect(text).not.toContain('HPIL-');expect(text).not.toContain('rubric_scores');});
 it('keeps candidate text inert and no labels preselected',()=>{const html=renderBlindReview(packet);expect(html).toContain('.textContent=item.candidate');expect(html).toContain("[c.id,null]");expect(html).not.toContain('fetch(');});
 it('generates syntactically valid offline JavaScript',()=>{const html=renderBlindReview(packet);const script=html.match(/<script>([\s\S]*)<\/script>/)?.[1];expect(script).toBeTruthy();expect(()=>new Script(script!)).not.toThrow();});
 it('never certifies independent human gold after one reviewer',()=>{expect(validateHumanSubmission(packet,submission())).toMatchObject({completed:44,reviewerCount:1,exportableAsIndependentGold:false,state:'single_review_complete_not_independent_gold'});});
 it('tracks incomplete and missing-source cases',()=>{const s=submission();s.reviews[0].labels[Object.keys(s.reviews[0].labels)[0]]=null;s.reviews[1].sourceVerified=false;expect(validateHumanSubmission(packet,s).completed).toBe(42);});
 it('rejects forged packet, unknown item and absent attestation',()=>{expect(()=>validateHumanSubmission(packet,{...submission(),packetHash:'bad'})).toThrow('mismatch');expect(()=>validateHumanSubmission(packet,{...submission(),humanAttestation:false})).toThrow('human');const s=submission();s.reviews[0].inputHash='changed';expect(()=>validateHumanSubmission(packet,s)).toThrow('stale');});
});
