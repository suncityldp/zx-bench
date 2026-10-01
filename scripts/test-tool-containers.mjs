import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const r=spawnSync(process.execPath,[fileURLToPath(new URL('node_modules/vitest/vitest.mjs',root)),'run','packages/core/src/evaluators/toolContractDocker.test.ts','packages/core/src/evaluators/toolCliCheckpointDocker.test.ts','--maxWorkers=1','--minWorkers=1','--reporter=verbose',...process.argv.slice(2)],{cwd:root,stdio:'inherit',env:{...process.env,ZXBENCH_CONTAINER_TESTS:'1'},windowsHide:true});
if(r.error)throw r.error;process.exitCode=r.status??1;
