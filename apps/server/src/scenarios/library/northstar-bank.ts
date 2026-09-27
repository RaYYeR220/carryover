import type { Scenario } from '../types.js';

// Replace a lost card. Marcus asks for the 8-digit member ID — a detail the user never
// pre-shares, so the relay must ask the user instead of guessing (the eval's negative
// control) — then transfers to Elena on the fraud team (a new voice on the line).
export const MEMBER_ID_ASK = 'And can I get your eight-digit member ID, please?';

export const northstarBank: Scenario = {
  info: {
    id: 'northstar-bank',
    label: 'Replace a lost card',
    business: 'Northstar Bank',
    description:
      "A phone menu, a short hold, then Marcus asks for the name, date of birth and the 8-digit member ID — which you haven't pre-shared — before transferring you to Elena on the fraud team.",
    suggestedGoal: 'Report my debit card lost and get a replacement',
    suggestedAutonomy: 'assist',
  },
  ringMs: 1500,
  start: 'menu',
  nodes: {
    menu: {
      kind: 'ivr',
      id: 'menu',
      prompt: {
        text: 'Thank you for calling Northstar Bank. For lost or stolen cards, press 1. For all other questions, press 0. To repeat this menu, press 9.',
        asset: 'northstar-menu',
      },
      options: [
        { digits: '1', next: 'hold' },
        { digits: '0', next: 'hold' },
        { digits: '9', next: 'menu' },
      ],
      repeatAfterMs: 6000,
      maxRepeats: 3,
    },
    hold: {
      kind: 'hold',
      id: 'hold',
      durationMs: 12_000,
      announcement: {
        text: 'Thank you for holding. Your call is important to us. The next available representative will be with you shortly.',
        asset: 'northstar-hold',
      },
      announceEveryMs: 8000,
      next: 'marcus',
    },
    marcus: {
      kind: 'rep',
      id: 'marcus',
      voice: 'michael',
      name: 'Marcus',
      persona:
        'You are a calm, by-the-book card services representative at Northstar Bank. Before you can lock or replace a card you must verify the caller with three things: full name, date of birth and member ID. You accept whatever name and date of birth they give, but you cannot skip the member ID, and you never say or guess the member ID yourself.',
      checklist: [
        "Ask for the cardholder's full name.",
        'Ask for their date of birth.',
        `Ask exactly: "${MEMBER_ID_ASK}" You cannot continue without it. If the caller needs a moment to find it, say that's fine and wait. If they give fewer or more than eight digits, ask them to repeat it.`,
        'Once you have the member ID, thank them and say the lost card is now locked. Then say: "I\'m transferring you to Elena on our fraud team to get the replacement ordered." Then call transfer_call.',
      ],
      greeting:
        'Thanks for holding, this is Marcus with Northstar Bank card services. How can I help you today?',
      keyterms: ['Northstar Bank', 'member ID', 'debit card', 'lost card'],
      transferTo: 'elena',
    },
    elena: {
      kind: 'rep',
      id: 'elena',
      voice: 'vera',
      name: 'Elena',
      persona:
        'You work on the Northstar Bank fraud team. Marcus has already verified the caller and locked their lost card, and you have ordered the replacement. It arrives at the address on file in 5 to 7 business days, and the old card number is permanently blocked. Do not ask for any more personal details.',
      checklist: [
        'Answer any questions about the replacement briefly: it arrives at the address on file in 5 to 7 business days, and the old card is permanently blocked.',
        'If they ask about suspicious charges, say none have gone through since the card was locked.',
        'Ask if there is anything else. If not, thank them and say goodbye.',
      ],
      greeting:
        "Hi, this is Elena on the Northstar fraud team. Marcus has locked your old card, and I've ordered your replacement. It will arrive at the address on file in 5 to 7 business days. Is there anything else I can help with?",
      keyterms: ['Northstar Bank', 'replacement card', 'fraud team'],
    },
  },
};
