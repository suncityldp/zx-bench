/** Desktop VRAM reserve is diagnostic information, not an inference-capacity limit. */
export function gpuReserveObservation(gpu,referenceMiB=1536){
  const freeMiB=Number(gpu?.freeMiB);
  return {freeMiB:Number.isFinite(freeMiB)?freeMiB:null,referenceMiB,
    belowReference:Number.isFinite(freeMiB)&&freeMiB<referenceMiB,
    automaticPause:false,policy:'diagnostic_only'};
}
