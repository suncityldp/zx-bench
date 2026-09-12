import {describe,it,expect} from 'vitest';
import {buildHE001BlindPacket} from './he001BlindReview.js';
import {he001Fixtures} from './he001Fixtures.js';
import {snapshotHash} from '../contracts/pack.js';
describe('HE-001 human packet hides author scores rather than manufacturing human labels',()=>{
 const input=he001Fixtures();
 it('exports only public criterion definitions and anonymized answers',()=>{
  const {packet,mapping}=buildHE001BlindPacket(input,'question-hash');
  expect(packet.items).toHaveLength(9);
  for(const item of packet.items){expect(Object.keys(item).sort()).toEqual(['answer','answerHash','id']);expect(item.answerHash).toBe(snapshotHash(item.answer));expect(item.answer).toBe(input.find(a=>a.id===mapping[item.id])?.answer);}
  const text=JSON.stringify(packet);expect(text).not.toMatch(/expectedScore|expectedCritical|weightedScore|assessments|polished_historical_overclaim|full_alternative/);
 });
 it('is deterministic and independent of incoming list order',()=>{
  expect(buildHE001BlindPacket(input,'q')).toEqual(buildHE001BlindPacket([...input].reverse(),'q'));
 });
 it('records the limited blinding and does not claim real model or independent human results',()=>{
  const {packet}=buildHE001BlindPacket(input,'q');expect(packet.answerOrigin).toContain('not_model_outputs');expect(packet.blindingLimit).toContain('not fully unexposed');
 });
 it('rejects duplicate IDs and blank answers',()=>{
  expect(()=>buildHE001BlindPacket([input[0],input[0]],'q')).toThrow();expect(()=>buildHE001BlindPacket([{id:'a',answer:''}],'q')).toThrow();
 });
});
