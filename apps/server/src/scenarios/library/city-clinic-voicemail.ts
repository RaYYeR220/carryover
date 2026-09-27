import type { Scenario } from '../types.js';

// Nobody picks up: 3 s of ringing, then the clinic's voicemail.
export const cityClinicVoicemail: Scenario = {
  info: {
    id: 'city-clinic-voicemail',
    label: 'After-hours voicemail',
    business: 'City Clinic',
    description:
      "Nobody picks up: the line rings, then the clinic's voicemail answers. Type your message and the agent leaves it after the tone.",
    suggestedGoal: 'Leave a message asking the clinic to call me back about my blood test results',
    suggestedAutonomy: 'assist',
  },
  ringMs: 3000,
  start: 'voicemail',
  nodes: {
    voicemail: {
      kind: 'voicemail',
      id: 'voicemail',
      prompt: {
        text: "You've reached City Clinic. We're closed. Please leave a message after the tone.",
        asset: 'cityclinic-voicemail',
      },
      recordMs: 20_000,
    },
  },
};
