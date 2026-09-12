import {snapshotHash} from '../contracts/pack.js';
import {boundaryPublicInputV2, type checkBoundaryAuditV2} from './boundaryClaimAuditV2.js';
import {assessBoundaryControl, type BoundaryControl} from './boundaryClaimControls.js';
/** Verify BOTH identities before adapting the v1 control assessor to the host-augmented v2 packet. */
export function assessBoundaryControlV2(control: BoundaryControl, checked: ReturnType<typeof checkBoundaryAuditV2>) {
  const originalHash = snapshotHash(control.input), augmentedHash = boundaryPublicInputV2(control.input).bindingHash;
  if (checked.originalInputHash !== originalHash || checked.bindingHash !== augmentedHash) throw new Error('Original or host-augmented binding mismatch');
  return {...assessBoundaryControl(control, {...checked, bindingHash: originalHash}), originalInputHash: originalHash, augmentedInputHash: augmentedHash,
    hostBindingAdapterVersion: 'boundary-control-binding-v1', promptChanged: false};
}
