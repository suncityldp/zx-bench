import { createCipheriv,createDecipheriv,randomBytes,scryptSync } from 'node:crypto';

// Keep the existing storage format so all saved project model settings remain usable.
const legacyDefaultKey = 'zxbench-default-key-change-me!';
function encryptionKey(secret = process.env.ZXBENCH_ENCRYPTION_KEY || legacyDefaultKey):Buffer {
  return scryptSync(secret,'zxbench-salt',32);
}
export function encryptApiKey(plainText:string):string {
  const iv=randomBytes(16),cipher=createCipheriv('aes-256-cbc',encryptionKey(),iv);
  return iv.toString('hex')+':'+cipher.update(plainText,'utf8','hex')+cipher.final('hex');
}
export function decryptApiKey(encrypted:string):string {
  const [ivHex,data]=encrypted.split(':');
  if(!ivHex||!data)return encrypted; // Legacy plaintext settings.
  const decrypt = (secret?:string) => {
    const decipher=createDecipheriv('aes-256-cbc',encryptionKey(secret),Buffer.from(ivHex,'hex'));
    return decipher.update(data,'hex','utf8')+decipher.final('utf8');
  };
  try { return decrypt(); }
  catch (error) {
    // Older releases captured the default during ESM imports, before .env loaded.
    // Read those records during upgrades; all new writes use the configured key.
    if (!process.env.ZXBENCH_ENCRYPTION_KEY || process.env.ZXBENCH_ENCRYPTION_KEY === legacyDefaultKey) throw error;
    try { return decrypt(legacyDefaultKey); } catch { throw error; }
  }
}
export function maskApiKey(key:string|null|undefined):string|null {
  if(!key)return null;
  return key.length<=4?'****':'*'.repeat(key.length-4)+key.slice(-4);
}
