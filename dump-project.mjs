import { writeFileSync } from 'node:fs';
const id = process.argv[2];
const arr = (await (await fetch('http://127.0.0.1:3001/api/scenarios')).json()).data;
const s = arr.find((x) => x.id === id);
if (!s) { console.log('NOT_FOUND'); process.exit(0); }
writeFileSync(`regress-work/${id}-full.json`, JSON.stringify(s, null, 1));
console.log('dumped', id, '| files:', (s.requirements?.files||[]).length, '| hiddenTests:', (s.requirements?.hiddenTests||[]).length, '| fn:', s.requirements?.functionName || '(无)');
