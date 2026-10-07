import {expect,it} from 'vitest';
import {runIsolatedTypescriptTypeSuite} from './isolatedTypescriptType.js';
const contract={protocol:'isolated-typescript-type-v1' as const,entrypoint:'Value',cases:[{id:'negative',kind:'negative' as const,description:'string must be rejected',code:'const bad:Value="wrong";'}]};
it('a genuine type mismatch satisfies a negative type test',async()=>{
 const r=await runIsolatedTypescriptTypeSuite('type Value=number;',contract);
 expect(r.infrastructureError).toBeUndefined();expect(r.compiled).toBe(true);expect(r.passed).toBe(1);
},15000);
it('base compilation errors and missing test names cannot earn negative credit',async()=>{
 const invalid=await runIsolatedTypescriptTypeSuite('type Value=Missing;',contract);
 expect(invalid.compiled).toBe(false);expect(invalid.passed).toBe(0);
 const absent=await runIsolatedTypescriptTypeSuite('type Other=number;',contract);
 expect(absent.compiled).toBe(true);expect(absent.passed).toBe(0);
},25000);
