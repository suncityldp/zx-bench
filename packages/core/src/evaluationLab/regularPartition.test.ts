import {describe,it,expect} from 'vitest';
import {verifyRegularPartition,type PartitionCertificate} from './regularPartition.js';
const p={alphabet:['0','1'],forbidden:['11'],minLength:2};
const brute=(certificate:PartitionCertificate)=>{
  const failures=new Set<string>();
  for(let n=2;n<=8;n++)for(let value=0;value<2**n;value++){
    const word=value.toString(2).padStart(n,'0'),allowed=!word.includes('11');
    const count=certificate.pieces.filter(piece=>certificate.side==='suffix'?word.endsWith(piece)&&!word.slice(0,word.length-piece.length).includes('11'):word.startsWith(piece)&&!word.slice(piece.length).includes('11')).length;
    if(allowed&&count===0)failures.add('missing');if(!allowed&&count>0)failures.add('invalid');if(count>1)failures.add('overlap');
  }return failures;
};
describe('regular-language proof checker repairs gold, not Judge labels',()=>{
  it('rejects the exact proof Judge incorrectly accepted, even though f(5)=13 is correct',()=>{
    const result=verifyRegularPartition(p,{side:'suffix',pieces:['0','10']});
    expect(result.pass).toBe(false);expect(result.witnesses).toEqual(expect.arrayContaining([
      {kind:'missing',word:'01',matchingPieces:[]},{kind:'overlap',word:'10',matchingPieces:[0,1]},
    ]));
  });
  it('accepts both correct orientations without special-casing a textual answer',()=>{
    expect(verifyRegularPartition(p,{side:'suffix',pieces:['0','01']}).pass).toBe(true);
    expect(verifyRegularPartition(p,{side:'prefix',pieces:['0','10']}).pass).toBe(true);
    expect(verifyRegularPartition(p,{side:'prefix',pieces:['10','0']}).pass).toBe(true);
  });
  it.each(['prefix','suffix'] as const)('agrees with independent finite enumeration on many %s decompositions',side=>{
    const words=['0','1','00','01','10','11'];
    for(const a of words)for(const b of words){const c={side,pieces:[a,b]},actual=verifyRegularPartition(p,c);expect(actual.pass).toBe(brute(c).size===0);}
  });
  it('checks forbidden cross-boundary substrings and duplicate branches',()=>{
    const wrong=verifyRegularPartition(p,{side:'suffix',pieces:['0','1']});expect(wrong.witnesses.some(w=>w.kind==='invalid'&&w.word==='11')).toBe(true);
    expect(verifyRegularPartition(p,{side:'suffix',pieces:['0','01','01']}).pass).toBe(false);
  });
  it('works on another alphabet and multiple forbidden patterns',()=>{
    const other={alphabet:['a','b'],forbidden:['aa','bb'],minLength:1};
    const result=verifyRegularPartition(other,{side:'prefix',pieces:['a','b']});
    expect(result.pass).toBe(false);expect(result.witnesses.some(w=>w.kind==='invalid')).toBe(true);
    expect(verifyRegularPartition({alphabet:['a','b'],forbidden:[],minLength:1},{side:'prefix',pieces:['a','b']}).pass).toBe(true);
  });
  it('a resource limit is an error, never silent proof success',()=>{
    expect(()=>verifyRegularPartition(p,{side:'suffix',pieces:['0','01']},1)).toThrow('limit');
    expect(()=>verifyRegularPartition(p,{side:'suffix',pieces:['']})).toThrow();
  });
});
