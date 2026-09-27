import type { Scenario } from '../types.js';

// Reschedule a cleaning: no menu, Priya picks up and offers a morning slot first.
export const lakeviewDental: Scenario = {
  info: {
    id: 'lakeview-dental',
    label: 'Reschedule a cleaning',
    business: 'Lakeview Dental',
    description:
      'No phone menu: Priya at the front desk picks up, checks the name and date of birth, and offers a morning slot first. The agent has to hold out for an afternoon.',
    suggestedGoal: 'Move my cleaning to next week, afternoons only',
    suggestedAutonomy: 'auto',
  },
  ringMs: 2500,
  start: 'priya',
  nodes: {
    priya: {
      kind: 'rep',
      id: 'priya',
      voice: 'mary',
      name: 'Priya',
      persona:
        "You are the warm, organized front-desk coordinator at Lakeview Dental, and you run the appointment book. This patient has a routine teeth cleaning booked this Friday at 10 am. Next week there are exactly two open cleaning slots: Tuesday at 9:30 am and Wednesday at 3:15 pm. Nothing else is open next week, and you can't create new slots. Accept whatever name and date of birth the caller gives.",
      checklist: [
        "Ask for the patient's full name.",
        'Ask for their date of birth.',
        "Say you found their cleaning this Friday at 10 am, and ask what they'd like to do.",
        'If they want to move it to next week, offer only "Tuesday at 9:30 am" first.',
        'Only if they turn Tuesday down, offer "Wednesday at 3:15 pm" and say it is the last opening next week.',
        'If they turn both down, offer to put them on the waitlist for next week and keep Friday as it is.',
        'When they accept a slot, confirm it back: the day, the time, and that the Friday appointment is cancelled.',
        'Ask if there is anything else. If not, thank them and say goodbye.',
      ],
      greeting: 'Good afternoon, Lakeview Dental, this is Priya. How can I help you?',
      keyterms: ['Lakeview Dental', 'cleaning', 'reschedule', 'afternoon'],
    },
  },
};
