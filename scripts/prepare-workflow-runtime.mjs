import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream,readFileSync,mkdirSync,existsSync,renameSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {spawnSync} from 'node:child_process';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const spec=JSON.parse(readFileSync(resolve(root,'docker/workflow-contracts/runtime.json'),'utf8'));
const args=process.argv.slice(2);
if(args.length && !(args.length===2 && args[0]==='--archive'))throw Error('Usage: pnpm runtime:workflow [--archive /path/to/image.tar.gz]');
function docker(argv){
 const r=spawnSync('docker',argv,{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 if(r.error||r.status!==0)throw Error(`docker ${argv[0]} failed: ${r.error?.message??r.stderr}`);
 return r.stdout.trim();
}
async function sha256(path){
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}
function verify(){
 const actual=docker(['image','inspect',spec.image,'--format','{{.Id}}']);
 if(actual!==spec.imageId)throw Error(`Workflow runtime image mismatch: ${actual}`);
 docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534',spec.image,'python3','-B','-c',"import yaml; assert yaml.__version__=='6.0.3'; assert yaml.safe_load('name: sample')['name']=='sample'"]);
 console.log(`Verified ${spec.image} (${spec.imageId}); PyYAML ${spec.pyyamlVersion}`);
}
if(!args.length){
 const r=spawnSync('docker',['image','inspect',spec.image,'--format','{{.Id}}'],{encoding:'utf8',timeout:15000});
 if(r.status===0&&r.stdout.trim()===spec.imageId){verify();process.exit(0);}
}
const archive=args.length?resolve(args[1]):resolve(root,'tmp','runtime',spec.asset);
if(!args.length&&!existsSync(archive)){
 mkdirSync(dirname(archive),{recursive:true});
 console.log(`Downloading ${spec.url}`);
 const response=await fetch(spec.url,{signal:AbortSignal.timeout(180000)});
 if(!response.ok||!response.body)throw Error(`Runtime download failed: HTTP ${response.status}`);
 const partial=archive+'.partial';
 try{await pipeline(Readable.fromWeb(response.body),createWriteStream(partial));
  if(await sha256(partial)!==spec.archiveSha256)throw Error('Downloaded runtime archive checksum mismatch');
  renameSync(partial,archive);
 }catch(error){rmSync(partial,{force:true});throw error;}
}
if(await sha256(archive)!==spec.archiveSha256)throw Error('Workflow runtime archive checksum mismatch');
console.log(docker(['load','--input',archive]));
verify();
