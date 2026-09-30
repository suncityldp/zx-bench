import {describe,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildChallengePack,gradeChallenge,referenceAnswer} from './challengePack.js';
import {CHALLENGE_SUPPLEMENT_IDS,CHALLENGE_SUPPLEMENT_SOURCE_HASH,CHALLENGE_SUPPLEMENT_SOURCE_VERSION,CHALLENGE_SUPPLEMENT_VERSION} from './challengeRelease.js';
import {CHALLENGE_SUPPLEMENT_RETIRED_IDS} from './challengeRetirement.js';
import type {Scenario} from '@zxbench/types';
import {checkScenarioEligibility} from '../contracts/eligibility.js';
import {hashScenarioShort} from '../contracts/canonicalize.js';

describe('lightweight challenge supplement freeze',()=>{
  const manifest=JSON.parse(readFileSync('data/scenarios/challenge-release-manifest.json','utf8'));
  const pack=buildChallengePack();
  const selected=[...manifest.selected.hallucination_resistance,...manifest.selected.reasoning_math];
  it('binds five discriminating questions to the frozen source pack',()=>{
    expect(manifest.version).toBe(CHALLENGE_SUPPLEMENT_VERSION);expect(manifest.sourcePackVersion).toBe(CHALLENGE_SUPPLEMENT_SOURCE_VERSION);expect(manifest.sourcePackHash).toBe(CHALLENGE_SUPPLEMENT_SOURCE_HASH);
    expect(manifest.sourcePackVersion).toBe(pack.version);expect(manifest.sourcePackHash).toBe(pack.hash);
    expect(selected).toEqual([...CHALLENGE_SUPPLEMENT_IDS]);
    expect(new Set(selected).size).toBe(5);expect(manifest.judgeCalls).toBe(0);
  });
  it('replays every selected deterministic gold successfully',()=>{
    for(const id of selected){const item=pack.cases.find(c=>c.id===id);expect(item).toBeDefined();expect(gradeChallenge(item!,JSON.stringify(referenceAnswer(item!))).strictPass).toBe(true);}
  });
  it('keeps ceiling and all-fail questions outside the supplement',()=>{
    expect(manifest.foundationOverflow).toHaveLength(14);expect(manifest.reviseOrExperimental).toEqual(['MC2-004']);
    expect([...manifest.foundationOverflow,...manifest.reviseOrExperimental].some((id:string)=>selected.includes(id))).toBe(false);
  });
  it('publishes exactly the five frozen questions as prospective deterministic scenarios',()=>{
    const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8')) as Scenario[];
    const archive=JSON.parse(readFileSync('data/scenarios/archive/benchmark-retired.json','utf8')) as Scenario[];
    const promoted=[...bank,...archive].filter(item=>item.grader==='challenge_supplement');
    expect(promoted.map(item=>item.id).sort()).toEqual([...CHALLENGE_SUPPLEMENT_IDS].sort());
    for(const item of promoted){
      const retired=CHALLENGE_SUPPLEMENT_RETIRED_IDS.includes(item.id as typeof CHALLENGE_SUPPLEMENT_RETIRED_IDS[number]);
      expect(item).toMatchObject({status:retired?'retired':'valid',reviewStatus:'verified',graderVersion:'1.0.0',maxReasoningTokens:90000});
      expect(item.scenarioHash).toBe(hashScenarioShort(item));
      if(retired) expect(checkScenarioEligibility(item).eligible).toBe(false);
      else expect(checkScenarioEligibility(item)).toEqual({eligible:true,reasons:[]});
    }
  });
});
