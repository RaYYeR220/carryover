// Maps the captions stream's speaker labels ("A", "B", …) to people numbered in order of
// first appearance, so the UI can say "Person 2" and spot a new voice (a transfer).

const DEFAULT_KEY = '\u0000default';

export class SpeakerMap {
  private readonly byLabel = new Map<string, number>();
  private readonly names = new Map<number, string>();
  private next = 1;
  private last: number | undefined;

  // An unlabeled turn belongs to whoever spoke last (or is the first speaker).
  assign(label: string | undefined): { person: number; isNew: boolean } {
    const key = usable(label);
    if (key === undefined && this.last !== undefined) return { person: this.last, isNew: false };
    const k = key ?? DEFAULT_KEY;
    const known = this.byLabel.get(k);
    if (known !== undefined) {
      this.last = known;
      return { person: known, isNew: false };
    }
    const person = this.next++;
    this.byLabel.set(k, person);
    this.last = person;
    return { person, isNew: true };
  }

  // Who a (partial) turn most likely belongs to, without registering anyone.
  peek(label: string | undefined): { person: number; isNew: boolean } {
    const key = usable(label);
    const known = key !== undefined ? this.byLabel.get(key) : this.last;
    if (known !== undefined) return { person: known, isNew: false };
    return { person: this.next, isNew: true };
  }

  setName(person: number, name: string): void {
    this.names.set(person, name);
  }

  nameOf(person: number): string | undefined {
    return this.names.get(person);
  }
}

function usable(label: string | undefined): string | undefined {
  return label && label !== 'UNKNOWN' ? label : undefined;
}
