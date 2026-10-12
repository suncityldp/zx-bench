import fs from 'node:fs';
import crypto from 'node:crypto';

/** Readers see a complete snapshot; concurrent processes never share a temp name. */
export function writeRuntimeJson(file,value){
  const temporary=file+'.tmp-'+process.pid+'-'+crypto.randomUUID();
  try{
    fs.writeFileSync(temporary,JSON.stringify(value,null,2),'utf8');
    const waits=[2,5,10,20,40,80];
    for(let attempt=0;;attempt++){
      try{fs.renameSync(temporary,file);break;}
      catch(error){
        // Windows may briefly refuse replacement while another reader/writer opens
        // the destination. Retain the complete old snapshot and retry for <=157ms.
        if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=waits.length)throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,waits[attempt]);
      }
    }
  }
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
}
