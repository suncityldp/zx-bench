import ts from 'typescript';

/** Remove only conventional leading answer labels, including bilingual labels. */
export function stripRepairAnswerLabel(output: string): string {
  return output.trim().replace(/^(?:(?:ANSWER|答案)\s*[:：]\s*\/?\s*)+/i, '').trim();
}

/** Keep a submitted module together: imports and sibling declarations are code. */
export function extractUnfencedRepairModule(output: string, language: string): string | null {
  const text = stripRepairAnswerLabel(output);
  const patterns: Record<string, RegExp> = {
    javascript: /^(?:import\b|export\b|(?:async\s+)?function\s+\w+|class\s+\w+|(?:const|let|var)\s+\w+\s*=)/,
    typescript: /^(?:import\b|export\b|(?:declare\s+)?(?:type|interface|enum|namespace)\s+\w+|(?:async\s+)?function\s+\w+|(?:abstract\s+)?class\s+\w+|(?:const|let|var)\s+\w+\s*=)/,
    python: /^(?:import\s+\S|from\s+\S+\s+import\b|(?:async\s+)?def\s+\w+\s*\(|class\s+\w+\s*[:(]|@[\w.]+)/,
    go: /^(?:package\s+\w+|import(?:\s|\()|func\s+|(?:type|var|const)\s+\w+)/,
    java: /^(?:package\s+|import\s+|@\w+|(?:(?:public|private|protected|static|final|abstract)\s+)*(?:class|interface|enum|record)\s+\w+)/,
    csharp: /^(?:using\s+|namespace\s+|(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\s+)*(?:class|interface|struct|record|enum)\s+\w+)/,
    cpp: /^(?:#\s*(?:include|pragma|define)\b|using\s+|namespace\s+|(?:class|struct|enum|typedef)\s+|[\w:<>]+(?:\s+[\w:<>]+)*\s*[*&]?\s+\w+\s*\([^;]*\)\s*\{)/,
    c: /^(?:#\s*(?:include|pragma|define)\b|(?:struct|enum|typedef)\s+|[\w]+(?:\s+[\w]+)*\s*\*?\s*\w+\s*\([^;]*\)\s*\{)/,
    rust: /^(?:use\s+|(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait|type|mod)\s+|impl\b)/,
  };
  const lang = ({js:'javascript',ts:'typescript',py:'python',golang:'go','c#':'csharp','c++':'cpp',rs:'rust'} as Record<string,string>)[language.toLowerCase()] ?? language.toLowerCase();
  const pattern=patterns[lang];
  if (!pattern) return null;
  const lines=text.split('\n');
  const start=lines.findIndex(line=>pattern.test(line.trim()));
  if (start<0) return null;
  // Explanatory text is removed only at a separate paragraph after code.
  let end=lines.length, quote:string|null=null, blockComment=false, depth=0;
  for(let i=start+1;i<lines.length;i++) {
    const line=lines[i-1];
    for(let k=0;k<line.length;k++) {
      if(blockComment) {if(line.startsWith('*/',k)){blockComment=false;k++;}continue;}
      if(quote) {
        if(line[k]==='\\'){k++;continue;}
        if(line.startsWith(quote,k)){k+=quote.length-1;quote=null;}
        continue;
      }
      if(line.startsWith('//',k)||lang==='python'&&line[k]==='#')break;
      if(line.startsWith('/*',k)){blockComment=true;k++;continue;}
      if(lang==='python'&&(line.startsWith('"""',k)||line.startsWith("'''",k))){quote=line.slice(k,k+3);k+=2;continue;}
      if(['"',"'",'`'].includes(line[k])){quote=line[k];continue;}
      if(line[k]==='{')depth++;
      if(line[k]==='}')depth--;
    }
    if (!quote&&!blockComment&&depth===0&&!line.trim() && /^(?:理由|原因|说明|解释|修复说明|Explanation|Reason|Notes?)\s*[:：]/i.test(lines[i])) {end=i;break;}
  }
  return lines.slice(start,end).join('\n').trim();
}

type SubmissionContract={protocol?:string;targetNames?:string[]};

/** Only an explicitly declared, single named TypeScript alias may be a patch. */
export function materializeTypeRepair(patch:string, original:string|undefined, contract:unknown):string {
  const policy=contract as SubmissionContract|undefined;
  if(policy?.protocol!=='source-or-target-declaration-v1'||!original||policy.targetNames?.length!==1)return patch;
  const submitted=ts.createSourceFile('candidate.ts',patch,ts.ScriptTarget.Latest,true);
  if(submitted.statements.length!==1||!ts.isTypeAliasDeclaration(submitted.statements[0]))return patch;
  const replacement=submitted.statements[0];
  if(replacement.name.text!==policy.targetNames[0])return patch;
  const initial=ts.createSourceFile('original.ts',original,ts.ScriptTarget.Latest,true);
  const matches=initial.statements.filter(s=>ts.isTypeAliasDeclaration(s)&&s.name.text===replacement.name.text);
  if(matches.length!==1)return patch;
  return original.slice(0,matches[0].getStart(initial))+patch+original.slice(matches[0].end);
}
