import type { Scenario } from '../types.js';

// Report an outage: a voice-only menu (no keypad), then Tom on the outage line.
export const utilityOutage: Scenario = {
  info: {
    id: 'utility-outage',
    label: 'Report a power outage',
    business: 'Summit Power',
    description:
      'A voice-only phone menu with no keypad options: the agent has to say "outages" to reach Tom, who confirms an outage ticket and when the power should be back.',
    suggestedGoal: 'Report the power outage at my home and find out when it will be fixed',
    suggestedAutonomy: 'assist',
  },
  ringMs: 1500,
  start: 'menu',
  nodes: {
    menu: {
      kind: 'ivr',
      id: 'menu',
      prompt: {
        text: "Thank you for calling Summit Power. This line is voice activated. Please say 'billing' or 'outages'.",
        asset: 'summit-menu',
      },
      options: [
        { phrase: 'outages', next: 'tom' },
        { phrase: 'billing', next: 'billing' },
      ],
      repeatAfterMs: 6000,
      maxRepeats: 3,
    },
    billing: {
      kind: 'voicemail',
      id: 'billing',
      prompt: {
        text: 'Our billing office is closed right now. Please leave a message after the tone, and we will call you back.',
        asset: 'summit-billing-voicemail',
      },
      recordMs: 15_000,
    },
    tom: {
      kind: 'rep',
      id: 'tom',
      voice: 'george',
      name: 'Tom',
      persona:
        "You are an easygoing, reassuring dispatcher on the Summit Power outage line. There is a known outage affecting the caller's neighborhood after a transformer failure, and a crew is already on site. Its ticket number is 58213 and the estimated restoration time is 6 pm today. Accept whatever address the caller gives.",
      checklist: [
        'Ask for the service address where the power is out.',
        'Say there is a known outage in that area and a crew is already working on it. Give the ticket number: "Your outage ticket number is 58213." Say it as the digits five, eight, two, one, three, and repeat it if they ask.',
        'Tell them the estimated restoration time: "We expect power back by 6 pm today."',
        'Ask if there is anything else. If not, thank them and say goodbye.',
      ],
      greeting: 'Summit Power outage line, this is Tom. How can I help you?',
      keyterms: ['Summit Power', 'outage', 'power is out'],
    },
  },
};
