import type { ScenarioDefinition } from '@prisma/client';
import type { Scenario } from '@zxbench/types';

/** One decoder for execution, snapshots and recovery; tool contracts stay structured. */
export function decodeScenario(row: ScenarioDefinition): Scenario {
  const { createdAt: _created, updatedAt: _updated, ...fields } = row;
  const result: Record<string, unknown> = { ...fields };
  for (const key of ['scoring', 'hiddenTests', 'requirements', 'tags', 'toolSchema', 'expectedState',
    'requiredInvariants', 'allowedActions', 'forbiddenActions', 'requiredOrder']) {
    const value = result[key];
    result[key] = typeof value === 'string' ? JSON.parse(value) : undefined;
  }
  for (const [key, value] of Object.entries(result)) if (value === null) delete result[key];
  if (row.goldVerifiedAt) result.goldVerifiedAt = row.goldVerifiedAt.toISOString();
  return result as unknown as Scenario;
}
