import type { ScenarioInfo } from '@carryover/protocol';
import type { Prompt, Scenario } from '../types.js';
import { cityClinicVoicemail } from './city-clinic-voicemail.js';
import { lakeviewDental } from './lakeview-dental.js';
import { northstarBank } from './northstar-bank.js';
import { riversidePharmacy } from './riverside-pharmacy.js';
import { utilityOutage } from './utility-outage.js';

export const SCENARIOS: readonly Scenario[] = [
  riversidePharmacy,
  lakeviewDental,
  northstarBank,
  cityClinicVoicemail,
  utilityOutage,
];

export function getScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((s) => s.info.id === id);
}

export function listScenarios(): ScenarioInfo[] {
  return SCENARIOS.map((s) => ({ ...s.info }));
}

// Every recorded prompt the library plays (menus, hold announcements, voicemail
// greetings), one entry per asset.
export function allPrompts(scenarios: readonly Scenario[] = SCENARIOS): Prompt[] {
  const byAsset = new Map<string, Prompt>();
  for (const s of scenarios) {
    for (const node of Object.values(s.nodes)) {
      const prompt =
        node.kind === 'hold' ? node.announcement : node.kind === 'rep' ? undefined : node.prompt;
      if (prompt && !byAsset.has(prompt.asset)) byAsset.set(prompt.asset, prompt);
    }
  }
  return [...byAsset.values()];
}
