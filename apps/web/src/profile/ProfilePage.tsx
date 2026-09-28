import type { Fact, UserDescriptor } from '@carryover/protocol';
import { type FormEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { vault } from '../lib/store';
import { factNote, MAX_FACTS } from '../start/request';
import { Button } from '../ui';
import s from './ProfilePage.module.css';
import { DESCRIPTOR_OPTIONS, loadDescriptor, saveDescriptor } from './profileMeta';
import { ensureSeeded } from './seed';

const NAME_KEY = 'name';

/** `"Member ID"` → `"member_id"`, deduplicated against the facts already in the vault. */
function keyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'fact';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`.slice(0, 40);
    if (!taken.has(candidate)) return candidate;
  }
}

interface EditState {
  key: string;
  label: string;
  value: string;
}

export default function ProfilePage() {
  const nameId = useId();
  const descId = useId();
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [descriptor, setDescriptor] = useState<UserDescriptor>(loadDescriptor);
  const [name, setName] = useState('');
  const [nameSaved, setNameSaved] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const editLabelRef = useRef<HTMLInputElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: focuses the label input each time a different fact starts editing
  useEffect(() => {
    editLabelRef.current?.focus();
  }, [editing?.key]);

  useEffect(() => {
    let live = true;
    ensureSeeded()
      .then(() => vault.list())
      .then((f) => {
        if (!live) return;
        setFacts(f);
        setName(f.find((x) => x.key === NAME_KEY)?.value ?? '');
      })
      .catch(() => {
        if (live) setFacts([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const otherFacts = useMemo(() => (facts ?? []).filter((f) => f.key !== NAME_KEY), [facts]);
  const takenKeys = useMemo(() => new Set((facts ?? []).map((f) => f.key)), [facts]);
  const atFactLimit = (facts?.length ?? 0) >= MAX_FACTS;

  const refresh = () => vault.list().then(setFacts);

  const saveName = async (e?: FormEvent) => {
    e?.preventDefault();
    const value = name.trim();
    if (!value) {
      setError('Name can’t be empty.');
      return;
    }
    try {
      await vault.save({ key: NAME_KEY, label: 'Name', value });
      await refresh();
      setError(null);
      setNameSaved(true);
      setTimeout(() => setNameSaved(false), 2000);
    } catch {
      setError('Couldn’t save your name. Try a shorter one.');
    }
  };

  const onDescriptor = (value: UserDescriptor) => {
    setDescriptor(value);
    saveDescriptor(value);
  };

  const startEdit = (f: Fact) => setEditing({ key: f.key, label: f.label, value: f.value });

  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const label = editing.label.trim();
    const value = editing.value.trim();
    if (!label || !value) {
      setError('Both a label and a value are needed.');
      return;
    }
    try {
      await vault.save({ key: editing.key, label, value });
      await refresh();
      setEditing(null);
      setError(null);
    } catch {
      setError('That label or value is too long.');
    }
  };

  const removeFact = async (key: string) => {
    await vault.remove(key);
    await refresh();
  };

  const addFact = async (e: FormEvent) => {
    e.preventDefault();
    if (atFactLimit) {
      setError(`You’ve reached the ${MAX_FACTS}-fact limit. Delete one to add another.`);
      return;
    }
    const label = newLabel.trim();
    const value = newValue.trim();
    if (!label || !value) {
      setError('Give the new fact a label and a value.');
      return;
    }
    const key = keyFromLabel(label, takenKeys);
    try {
      await vault.save({ key, label, value });
      await refresh();
      setNewLabel('');
      setNewValue('');
      setError(null);
    } catch {
      setError('That label or value is too long.');
    }
  };

  return (
    <div className={s.page}>
      <div className={s.wrap}>
        <div className={s.top}>
          <h1 className={s.h1}>Your profile</h1>
          <nav className={s.nav} aria-label="Carryover">
            <Link to="/app/new">New call</Link>
            <Link to="/app/history">History</Link>
            <Link to="/app/profile" aria-current="page">
              Profile
            </Link>
          </nav>
        </div>
        <p className={s.lede}>Stays on this device. You choose what each call may share.</p>

        <section className={s.section}>
          <fieldset className={s.aboutFieldset}>
            <legend className={s.lbl}>About you</legend>
            <div className={s.about}>
              <form className={s.field} onSubmit={saveName}>
                <label className={s.lbl} htmlFor={nameId}>
                  Name
                </label>
                <input
                  id={nameId}
                  value={name}
                  maxLength={40}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => saveName()}
                />
                {nameSaved && (
                  <p className={s.saved} role="status">
                    Saved.
                  </p>
                )}
              </form>
              <div className={s.field}>
                <label className={s.lbl} htmlFor={descId}>
                  Descriptor
                </label>
                <select
                  id={descId}
                  value={descriptor}
                  onChange={(e) => onDescriptor(e.target.value as UserDescriptor)}
                >
                  {DESCRIPTOR_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <p className={s.help}>
                  How Carryover thinks of you. It never says this to the other side.
                </p>
              </div>
            </div>
          </fieldset>
        </section>

        <section className={s.section}>
          <span className={s.lbl} id="factsL">
            Facts Carryover can share
          </span>
          <p className={s.factsHelp}>
            Toggle any of these per call from the start page. Carryover only offers what you turn
            on; it asks you first for anything else.
          </p>
          {facts == null ? (
            <p className={s.help}>Loading…</p>
          ) : (
            <ul className={s.facts} aria-labelledby="factsL">
              {otherFacts.map((f) =>
                editing?.key === f.key ? (
                  <li key={f.key}>
                    <form className={s.editRow} onSubmit={saveEdit}>
                      <input
                        ref={editLabelRef}
                        aria-label={`Label for ${f.label}`}
                        value={editing.label}
                        maxLength={60}
                        onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                      />
                      <input
                        aria-label={`Value for ${f.label}`}
                        value={editing.value}
                        maxLength={200}
                        onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                      />
                      <span className={s.factActs}>
                        <Button type="submit" variant="ink" size="sm">
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="line"
                          size="sm"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                      </span>
                    </form>
                  </li>
                ) : (
                  <li key={f.key} className={s.fact}>
                    <span>
                      <b>{f.label}</b>
                      <span>{f.value}</span>
                      {factNote(f.key) && <small>{factNote(f.key)}</small>}
                    </span>
                    <span className={s.factActs}>
                      <Button variant="line" size="sm" onClick={() => startEdit(f)}>
                        Edit
                      </Button>
                      <Button variant="line" size="sm" onClick={() => removeFact(f.key)}>
                        Delete
                      </Button>
                    </span>
                  </li>
                ),
              )}
            </ul>
          )}
          <form className={s.addForm} onSubmit={addFact}>
            <input
              aria-label="New fact label"
              placeholder="Label, e.g. Pharmacy account"
              value={newLabel}
              maxLength={60}
              disabled={atFactLimit}
              onChange={(e) => setNewLabel(e.target.value)}
            />
            <input
              aria-label="New fact value"
              placeholder="Value"
              value={newValue}
              maxLength={200}
              disabled={atFactLimit}
              onChange={(e) => setNewValue(e.target.value)}
            />
            <Button type="submit" variant="soft" size="sm" disabled={atFactLimit}>
              Add fact
            </Button>
          </form>
          {atFactLimit && (
            <p className={s.help}>
              You’ve reached the {MAX_FACTS}-fact limit. Delete one to add another.
            </p>
          )}
          {error && (
            <p className={s.error} role="alert">
              {error}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
