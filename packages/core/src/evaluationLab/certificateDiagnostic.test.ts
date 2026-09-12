import {describe,it,expect} from 'vitest';
import {certificateDiagnostic} from './certificateDiagnostic.js';
describe('certificate diagnostics never repair answers',()=>{
  it('accepts whole valid answer',()=>expect(certificateDiagnostic('{"x":1}').state).toBe('whole_answer'));
  it('binds the exact fenced bytes and keeps prose separate',()=>{const raw='解释\n```json\n{"x":1}\n```\n注释';const d=certificateDiagnostic(raw);expect(d.state).toBe('explicit_single_json_fence');if(d.certificate)expect(raw.slice(d.start,d.end)).toBe(d.certificate);});
  it('does not choose among multiple objects',()=>expect(certificateDiagnostic('```json\n{}\n```\n```json\n{"x":1}\n```').state).toBe('unresolved'));
  it('does not repair invalid JSON or infer unmarked objects',()=>{expect(certificateDiagnostic('说明 {"x":1}').state).toBe('unresolved');expect(certificateDiagnostic('说明```json\n{"x":}\n```').state).toBe('unresolved');});
});
