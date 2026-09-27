import type { Scenario } from '../types.js';

// Refill a prescription: keypad menu (2), 18 s on hold, then Dana at the pharmacy counter.
export const riversidePharmacy: Scenario = {
  info: {
    id: 'riverside-pharmacy',
    label: 'Prescription refill',
    business: 'Riverside Pharmacy',
    description:
      'A phone menu (press 2 for refills), about 18 seconds on hold, then Dana at the pharmacy counter checks the name and date of birth and says when the refill will be ready.',
    suggestedGoal: 'Refill my lisinopril prescription and find out when it will be ready',
    suggestedAutonomy: 'assist',
  },
  ringMs: 2000,
  start: 'menu',
  nodes: {
    menu: {
      kind: 'ivr',
      id: 'menu',
      prompt: {
        text: 'Thank you for calling Riverside Pharmacy. For prescription refills, press 2. For store hours, press 3. To repeat this menu, press 9.',
        asset: 'riverside-menu',
      },
      options: [
        { digits: '2', next: 'hold' },
        { digits: '3', next: 'hours' },
        { digits: '9', next: 'menu' },
      ],
      repeatAfterMs: 6000,
      maxRepeats: 3,
    },
    hours: {
      kind: 'ivr',
      id: 'hours',
      prompt: {
        text: 'Riverside Pharmacy is open Monday to Friday from 8 am to 9 pm, and on weekends from 9 am to 6 pm. To return to the main menu, press 9.',
        asset: 'riverside-hours',
      },
      options: [{ digits: '9', next: 'menu' }],
      repeatAfterMs: 5000,
      maxRepeats: 1,
      onTimeout: 'menu',
    },
    hold: {
      kind: 'hold',
      id: 'hold',
      durationMs: 18_000,
      announcement: {
        text: 'Your call is important to us. A pharmacy team member will be with you shortly.',
        asset: 'riverside-hold',
      },
      announceEveryMs: 9000,
      next: 'dana',
    },
    dana: {
      kind: 'rep',
      id: 'dana',
      voice: 'jane',
      name: 'Dana',
      persona:
        "You are a friendly, efficient pharmacy technician at the Riverside Pharmacy counter. You handle refill requests. The pharmacy system shows one active prescription for this patient: lisinopril, 10 milligrams, with refills remaining. You can't verify identity details beyond writing them down, so accept whatever name and date of birth the caller gives.",
      checklist: [
        "Ask for the patient's full name.",
        'Ask for their date of birth.',
        "Ask which prescription they'd like refilled. You expect lisinopril. If they name a different medicine, say the only active prescription on file is lisinopril and ask whether that is the one.",
        'Tell them exactly: "It\'ll be ready Thursday after 2 pm, reference 4471." Say the reference as the digits four, four, seven, one, and repeat it if they ask.',
        'Ask if there is anything else. If not, thank them and say goodbye.',
      ],
      greeting: 'Riverside Pharmacy, this is Dana speaking. How can I help you today?',
      keyterms: ['lisinopril', 'Riverside Pharmacy', 'refill', 'prescription'],
    },
  },
};
