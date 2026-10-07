/** Move submitted Go header imports into the driver's header, never into its body. */
export function splitGoSubmission(source:string):{imports:string[];body:string} {
  let rest=source.trim().replace(/^package\s+\w+\s*(?:;|\n)/,'');
  const imports:string[]=[];
  for (;;) {
    const header=rest.match(/^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*import\s*(\([\s\S]*?\)|(?:[\w.]+\s+)?(?:"[^"\n]+"|`[^`\n]+`))\s*;?/);
    if(!header)break;
    const entries=header[1].replace(/^\(|\)$/g,'').replace(/\/\/[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
    for(const m of entries.matchAll(/(?:([\w.]+)\s+)?("[^"\n]+"|`[^`\n]+`)/g))imports.push((m[1]?m[1]+' ':'')+JSON.stringify(m[2].slice(1,-1)));
    rest=rest.slice(header[0].length).trimStart();
  }
  return {imports,body:rest};
}
