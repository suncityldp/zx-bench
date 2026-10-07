import {describe,it,expect} from 'vitest';
import {exactAnswerLineEvaluator} from './exactAnswerLine.js';
import {buildExamPaper,gradePart,gradeReviewedMathPart,referenceOutput,scoreExam} from '../evaluationLab/examExpansion/index.js';
import {analyzeRunQuality} from '../quality.js';
import {reviewAnswerFields} from './mathAnswerFields.js';
import {readFileSync} from 'node:fs';

const policy='math-content-protocol-20261007-v1';
const compound:any={grader:'exact_answer_line',dimension:'reasoning_math',scoring:{comparisonMode:'strict',mathReviewPolicy:policy},requirements:{answer:'A=109万，B=114.91万，C=108.48万，B年化=4.74%，最高=B',answerFields:[{label:'A=',expected:'109万',weight:1},{label:'B=',expected:'114.91万',weight:1},{label:'C=',expected:'108.48万',weight:1},{label:'B年化=',expected:'4.74%',weight:1},{label:'最高=',expected:'B',weight:1}]}};
describe('reviewed mathematical content and delivery contracts',()=>{
 it('keeps every declared field exact while applying independent credit across the reviewed bank',async()=>{
   const bank=JSON.parse(readFileSync('data/scenarios/benchmark.json','utf8'));
   const scenarios=bank.filter((s:any)=>s.scoring?.mathReviewPolicy===policy&&s.requirements?.answerFields);
   expect(scenarios.length).toBeGreaterThan(20);
   for(const s of scenarios){
     const fields=s.requirements.answerFields;
     const render=(wrong=-1)=>'ANSWER: '+fields.map((f:any,i:number)=>f.label+(i===wrong?'WRONG_VALUE':f.expected)).join('，');
     expect((await exactAnswerLineEvaluator.evaluate(s,render(),{} as any)).axisScores?.answer_accuracy,s.id).toBe(100);
     const weight=fields.reduce((n:number,f:any)=>n+f.weight,0);
     for(let i=0;i<fields.length;i++){
       const result=await exactAnswerLineEvaluator.evaluate(s,render(i),{} as any);
       expect(result.axisScores?.answer_accuracy,s.id+' '+fields[i].label).toBeCloseTo(100*(weight-fields[i].weight)/weight,8);
     }
   }
 });
 it('gives four independently correct compound fields credit without tolerating the wrong cent',async()=>{
   const r=await exactAnswerLineEvaluator.evaluate(compound,'ANSWER: A=109.00万，B=114.91万，C=108.49万，B年化=4.74%，最高=B',{} as any);
   expect(r.axisScores?.answer_accuracy).toBe(80);expect(r.totalScore).toBe(82);
   const correct=await exactAnswerLineEvaluator.evaluate(compound,'ANSWER: A=109万，B=114.91万，C=108.48万，B年化=4.74%，最高=B',{} as any);
   expect(correct.totalScore).toBe(100);
 });
 it('accepts only declared label equivalence, preserving different meetings and numbers',async()=>{
   const s:any={...compound,requirements:{answer:'冲突=A和B、D和E，最长空闲=60分钟',answerFields:[{label:'冲突=',expected:'A和B、D和E',weight:1,aliases:{会议A:'A',会议B:'B',会议D:'D',会议E:'E'}},{label:'最长空闲=',expected:'60分钟',weight:1}]}};
   expect((await exactAnswerLineEvaluator.evaluate(s,'ANSWER: 冲突=[会议A和会议B、会议D和会议E]，最长空闲=[60]分钟',{} as any)).totalScore).toBe(100);
   expect((await exactAnswerLineEvaluator.evaluate(s,'ANSWER: 冲突=会议A和会议D、会议B和会议E，最长空闲=60分钟',{} as any)).axisScores?.answer_accuracy).toBe(50);
 });
 it('does not mine preceding reasoning or accept duplicate fields as a correct final answer',async()=>{
   const r=await exactAnswerLineEvaluator.evaluate(compound,'A=109万，B=114.91万，C=108.48万，B年化=4.74%，最高=B\nANSWER: A=1万，B=1万，C=1万，B年化=1%，最高=A',{} as any);
   expect(r.axisScores?.answer_accuracy).toBe(0);
   const duplicate=reviewAnswerFields('A=1,A=2',[{label:'A=',expected:'1',weight:1}],(a,b)=>a===b?100:0);
   expect(duplicate.accuracy).toBe(0);
 });
 it('keeps exact mathematics separate from canonical versus combined JSON',()=>{
   const p=buildExamPaper().parts.find(p=>p.id==='MX3-18-P3')!;
   expect(gradePart(p,'{"cycle_types":12,"odd_only":525}').earned).toBe(0);
   expect(gradeReviewedMathPart(p,'{"cycle_types":12,"odd_only":525}')).toMatchObject({contentEarned:30,earned:27,protocolValid:false});
   expect(gradeReviewedMathPart(p,referenceOutput(p))).toMatchObject({contentEarned:30,earned:30,protocolValid:true});
   expect(gradeReviewedMathPart(p,'{"cycle_types":13,"odd_only":525}')).toMatchObject({contentEarned:15,earned:13.5});
   expect(gradeReviewedMathPart(p,'{"cycle_types":12,"odd_only":')).toMatchObject({contentEarned:0,earned:0});
 });
 it('preserves large exact integer literals in combined JSON',()=>{
   const p:any={points:10,items:[{key:'n',points:10,kind:'exact',expected:'9221519018813407615'}]};
   expect(gradeReviewedMathPart(p,'{"n":9221519018813407615}').contentEarned).toBe(10);
 });
 it('applies the same 90/10 policy through the standalone exam scorer',()=>{
   const p=buildExamPaper({groupIds:['MX3-18']});
   const answers=p.parts.map(part=>({id:part.id,questionHash:part.question.questionHash,outcome:'completed' as const,output:part.id==='MX3-18-P3'?'{"cycle_types":12,"odd_only":525}':referenceOutput(part)}));
   expect(scoreExam(p,{contractHash:p.contractHash,runId:'synthetic',modelId:'synthetic',modelFamily:'synthetic',answers}).score).toBe(97);
 });
 it('separates an excluded question defect from runtime infrastructure errors',()=>{
   const q=analyzeRunQuality([{scenarioId:'MX3-20-P4',totalScore:0,deterministicScore:0,judgeScore:null,modelOutput:'',outputMetadata:JSON.stringify({mathRevision:{disposition:'excluded_defective_question'}}),environmentError:true}],1);
   expect(q).toMatchObject({benchmarkDefectCount:1,runtimeEnvironmentErrorCount:0,referenceAnswerIssueCount:1});
 });
 it('defines the CRT total as an unreduced sum and retains all executable references',()=>{
   const paper=buildExamPaper();
   const crt=paper.parts.find(p=>p.id==='MX3-20-P4')!;
   expect(crt.question.messages[0].content).toContain('total 不对 n 取模');
   expect(gradePart(crt,referenceOutput(crt)).earned).toBe(40);
   for(const p of paper.parts) expect(gradePart(p,referenceOutput(p)).earned,p.id).toBe(p.points);
 });
});
