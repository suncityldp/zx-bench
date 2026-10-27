import {it,expect,vi} from 'vitest';
import {execAsync} from './execAsync.js';
import {ensureContainerImage} from './containerRunner.js';
vi.mock('./execAsync.js',()=>({execAsync:vi.fn()}));
const frozen='zxbench/go@sha256:bbe499b0985c0481a47548381d03e2a46ded78e13411b8e5865b0efbdb391e03';
it('uses alias for cache and final inspect',async()=>{
 vi.mocked(execAsync).mockReset().mockResolvedValue({status:0,stdout:'',stderr:''});
 await ensureContainerImage(frozen);
 expect(vi.mocked(execAsync).mock.calls.map(c=>c[1])).toEqual([['image','inspect','zxbench/go:1.21-gcc'],['image','inspect','zxbench/go:1.21-gcc']]);
});
it('retains original requested identity when final inspection fails',async()=>{
 vi.mocked(execAsync).mockReset().mockResolvedValueOnce({status:0,stdout:'',stderr:''}).mockResolvedValueOnce({status:1,stdout:'',stderr:''});
 await expect(ensureContainerImage(frozen)).rejects.toThrow(frozen);
});
it('keeps public and unknown digest unchanged',async()=>{
 for(const image of ['node@sha256:unknown','zxbench/go@sha256:unknown']){
 vi.mocked(execAsync).mockReset().mockResolvedValue({status:0,stdout:'',stderr:''});
 await ensureContainerImage(image);
 expect(vi.mocked(execAsync).mock.calls.every(c=>c[1][2]===image)).toBe(true);
 }
});
it('builds the exact alias once and fails final inspection without pulling',async()=>{
 vi.mocked(execAsync).mockReset().mockResolvedValue({status:1,stdout:'',stderr:'mock build failure'});
 await expect(ensureContainerImage(frozen)).rejects.toThrow(frozen);
 await expect(ensureContainerImage(frozen)).rejects.toThrow(frozen);
 const calls=vi.mocked(execAsync).mock.calls.map(c=>c[1]);
 expect(calls.filter(c=>c[0]==='build')).toHaveLength(1);
 expect(calls.find(c=>c[0]==='build')).toContain('zxbench/go:1.21-gcc');
 expect(calls.some(c=>c[0]==='pull')).toBe(false);
});
it('inspects the alias after a successful build',async()=>{
 vi.resetModules();
 const {ensureContainerImage:freshEnsure}=await import('./containerRunner.js');
 let built=false;
 vi.mocked(execAsync).mockReset().mockImplementation(async(_cmd,args)=>{
  if(args[0]==='build')built=true;
  return {status:args[0]==='image'&&!built?1:0,stdout:'',stderr:''};
 });
 await freshEnsure(frozen);
 const calls=vi.mocked(execAsync).mock.calls.map(c=>c[1]);
 expect(calls.filter(c=>c[0]==='build')).toHaveLength(1);
 expect(calls.at(-1)).toEqual(['image','inspect','zxbench/go:1.21-gcc']);
});
it('preserves full public and unknown sha256 identities',async()=>{
 for(const image of ['node@sha256:'+'a'.repeat(64),'zxbench/go@sha256:'+'b'.repeat(64)]){
 vi.mocked(execAsync).mockReset().mockResolvedValue({status:0,stdout:'',stderr:''});
 await ensureContainerImage(image);
 expect(vi.mocked(execAsync).mock.calls.map(c=>c[1])).toEqual([['image','inspect',image],['image','inspect',image]]);
 }
});
