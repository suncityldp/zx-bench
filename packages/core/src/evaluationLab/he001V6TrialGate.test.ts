import {it,expect} from 'vitest';
import {nextHE001V6Call} from './he001V6TrialGate.js';
const plan=['01','02','03','04'];
it('authorizes exactly the first untouched slot',()=>expect(nextHE001V6Call(plan,[],[],{})).toBe('01'));
it('requires a bound review and does not silently retry or skip a failed stage',()=>{
 const calls=[{id:'01',status:'structurally_valid',contentHash:'h'}];
 expect(()=>nextHE001V6Call(plan,calls,['01'],{})).toThrow();
 expect(nextHE001V6Call(plan,calls,['01'],{'01':{decision:'continue',contentHash:'h',notes:['Reviewed candidate attribution.']}})).toBe('02');
 for(const decision of ['stop','continue'])expect(()=>nextHE001V6Call(plan,calls,['01'],{'01':{decision,contentHash:'wrong',notes:['review']}})).toThrow();
 expect(()=>nextHE001V6Call(plan,[{...calls[0],status:'failed'}],['01'],{})).toThrow();
 expect(()=>nextHE001V6Call(plan,[],['01'],{})).toThrow();
});
it('rejects over-budget or out-of-order attempts',()=>{
 expect(()=>nextHE001V6Call(plan,plan.map(id=>({id,status:'structurally_valid',contentHash:'x'})),plan,{})).toThrow();
 expect(()=>nextHE001V6Call(plan,[{id:'02',status:'structurally_valid',contentHash:'x'}],['02'],{})).toThrow();
});
