import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

/** Durable cross-process deduplication with recovery of a dead sender's claim. */
export async function sendExceptionOnce({key,directory,send,isAlive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}},now=Date.now(),leaseMs=90000}){
  fs.mkdirSync(directory,{recursive:true});
  const db=new DatabaseSync(path.join(directory,'notification-claims.sqlite'));
  db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS Claim (key TEXT PRIMARY KEY, owner INTEGER, nonce TEXT, at INTEGER, state TEXT)');
  const nonce=crypto.randomUUID();let owns=false;
  try{
    db.exec('BEGIN IMMEDIATE');
    const previous=db.prepare('SELECT * FROM Claim WHERE key=?').get(key);
    if(previous?.state==='delivered'||(previous?.state==='pending'&&isAlive(previous.owner)&&now-previous.at<leaseMs)){
      db.exec('COMMIT');return {duplicate:true};
    }
    db.prepare("INSERT INTO Claim VALUES(?,?,?,?, 'pending') ON CONFLICT(key) DO UPDATE SET owner=excluded.owner,nonce=excluded.nonce,at=excluded.at,state=excluded.state").run(key,process.pid,nonce,now);
    db.exec('COMMIT');owns=true;
    const delivery=await send();
    db.prepare("UPDATE Claim SET state='delivered' WHERE key=? AND nonce=?").run(key,nonce);
    return delivery;
  }catch(error){
    if(db.isTransaction)db.exec('ROLLBACK');
    if(owns)db.prepare("UPDATE Claim SET state='failed' WHERE key=? AND nonce=?").run(key,nonce);
    throw error;
  }finally{db.close();}
}
