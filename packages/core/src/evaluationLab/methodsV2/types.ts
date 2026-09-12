import {snapshotHash} from '../../contracts/pack.js';
export const VERSION='resistance-math-methods-2026-09-12-v2.1';
export type Split='development'|'holdout';
export type Dimension='hallucination_resistance'|'reasoning_math';
export type Stance='supported'|'refuted'|'insufficient'|'conflict';
export interface Question {id:string;dimension:Dimension;messages:{role:'user';content:string}[];questionHash:string}
export interface Base {id:string;family:string;split:Split;instance:number;group:string;variant:string;question:Question}
export interface Evidence extends Base {kind:'evidence';gold:{status:Stance;sources:string[]};documents:Record<string,string>}
export interface AllocationData {items:{cost:number;gain:number;risk:number}[];budget:number;riskLimit:number;requires:[number,number][];excludes:[number,number][];minCount:number}
export interface CountingData {counts:[number,number,number];modulus:number;residue:number}
export interface LinearData {a:number[][];b:number[]}
export interface Math extends Base {kind:'allocation'|'counting'|'linear';data:AllocationData|CountingData|LinearData}
export type Case=Evidence|Math;
export interface Options {seed:number;instances:number;split:Split}
export interface Pack {options:Options;policy:typeof POLICY;cases:Case[];contractHash:string}
export const POLICY={version:VERSION,scope:'development_lab_only',judgeCalls:0,productionEligible:false,
  independentGold:false,difficultyCalibrated:false,combinedScore:null,
  primary:'one_explicit_attempt_per_item_strict_pass_no_implicit_selection_or_best_of',
  aggregation:'equal_family_mean_only_if_all_planned_items_measured',
  missing:'missing_truncated_environment_error_and_grader_error_are_unmeasured',
  malformed:'completed_invalid_format_is_failure_reported_separately',
  split:'template_family_disjoint_not_proof_of_semantic_independence',
  hallucinationScope:'closed_evidence_support_not_open_world_truth',
  mathScope:'bounded_exact_answer_and_certificate_not_free_form_proof',
  sampling:{concurrency:1,hardTimeoutSeconds:1200,maxTokens:90000,contextLength:131072,temperature:0.6,topP:0.95,topK:20,minP:0,
    seed:20260910,enableThinking:true,repetitionPenalty:1,presencePenalty:0,frequencyPenalty:0},
} as const;
export function question(id:string,dimension:Dimension,prompt:string):Question {
  const value={id,dimension,messages:[{role:'user' as const,content:prompt}]};
  return {...value,questionHash:snapshotHash(value)};
}
/** Stable seeded generator. Seeds are metadata, not evidence of secrecy or statistical independence. */
export function random(seed:number) {let s=seed>>>0;return ()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
export function shuffle<T>(values:T[],seed:number):T[]{const out=[...values],r=random(seed);for(let i=out.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;}
export const opaque=(value:unknown)=>'V2-'+snapshotHash(value).slice(0,14);
