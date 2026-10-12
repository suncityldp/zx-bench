import test from 'node:test';
import assert from 'node:assert/strict';
import {gpuReserveObservation} from './lib/gpu-reserve-observation.mjs';
test('below-reference desktop VRAM does not independently authorize pausing a run',()=>{
  for(const freeMiB of [1474,1519,1705]){const observation=gpuReserveObservation({freeMiB},1536);assert.equal(observation.automaticPause,false);assert.equal(observation.belowReference,freeMiB<1536);assert.equal(observation.freeMiB,freeMiB);}
});
test('unavailable reserve metric is recorded without inventing a capacity failure',()=>{
  const observation=gpuReserveObservation({freeMiB:NaN});assert.equal(observation.freeMiB,null);assert.equal(observation.automaticPause,false);
});
