// Read again to verify an outcome is valid. Mutating actions retain exact
// multiplicity, order, target state and safety requirements.
export function repairReadVerification(world, sourceId) {
  const readPaths = {
    'HA-CN-003': 'read', 'HA-CN-005': 'reads', 'HA-CN-006': 'reads',
    'HA-CN-007': 'reads', 'HA-CN-017': 'reads', 'HA-CN-044': 'queries',
  };
  let changed = false;
  for (const state of world.expectedState ?? []) {
    if (state.path === readPaths[sourceId] && state.equals === 1) {
      delete state.equals; state.atLeast = 1; changed = true;
    }
    if (sourceId === 'HA-CN-006' && state.path === 'searches' && !state.allowExtraReadValues) {
      state.allowExtraReadValues = [...state.equals]; changed = true;
    }
    if (['HA-CN-026', 'HA-CN-030'].includes(sourceId) && state.path === 'operations'
        && !state.allowExtraReadValues) {
      state.allowExtraReadValues = ['list']; changed = true;
    }
  }
  return changed;
}
