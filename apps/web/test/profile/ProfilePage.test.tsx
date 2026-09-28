import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { vault } from '../../src/lib/store';
import ProfilePage from '../../src/profile/ProfilePage';
import { loadDescriptor } from '../../src/profile/profileMeta';
import { resetSeedState } from '../../src/profile/seed';
import { MAX_FACTS } from '../../src/start/request';

function renderPage() {
  return render(
    <MemoryRouter>
      <ProfilePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetSeedState();
});

describe('ProfilePage: seeding', () => {
  it('seeds the default name, dob, address and member ID the first time the vault is empty', async () => {
    renderPage();
    expect(await screen.findByDisplayValue('Maya Chen')).toBeInTheDocument();
    expect(screen.getByText('March 14, 1952')).toBeInTheDocument();
    expect(screen.getByText('41 Alder Street, Portland OR 97205')).toBeInTheDocument();
    expect(screen.getByText('40718233')).toBeInTheDocument();
    expect(screen.getByText('Not shared by default.')).toBeInTheDocument();
    expect(await vault.list()).toHaveLength(4);
  });

  it('never reseeds once the vault has been touched, even if it becomes empty again', async () => {
    await vault.save({ key: 'name', label: 'Name', value: 'Someone Else' });
    renderPage();
    expect(await screen.findByDisplayValue('Someone Else')).toBeInTheDocument();
    expect(screen.queryByText('March 14, 1952')).toBeNull();
  });
});

describe('ProfilePage: editing', () => {
  it('saves a new name on blur', async () => {
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByDisplayValue('Maya Chen');
    await user.clear(input);
    await user.type(input, 'Maya C.');
    await user.tab();
    await waitFor(async () => {
      expect((await vault.list()).find((f) => f.key === 'name')?.value).toBe('Maya C.');
    });
  });

  it('changes and persists the descriptor', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Maya Chen');
    const select = screen.getByLabelText('Descriptor');
    await user.selectOptions(select, 'hard-of-hearing');
    expect(loadDescriptor()).toBe('hard-of-hearing');
  });

  it('edits an existing fact', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('41 Alder Street, Portland OR 97205');
    const [editBtn] = screen.getAllByRole('button', { name: 'Edit' });
    await user.click(editBtn as HTMLElement);
    const valueBox = screen.getByLabelText('Value for Date of birth');
    await user.clear(valueBox);
    await user.type(valueBox, 'March 15, 1952');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(async () => {
      expect((await vault.list()).find((f) => f.key === 'dob')?.value).toBe('March 15, 1952');
    });
  });

  it('deletes a fact', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('40718233');
    const row = screen.getByText('40718233').closest('li');
    expect(row).not.toBeNull();
    const del = Array.from(row?.querySelectorAll('button') ?? []).find(
      (b) => b.textContent === 'Delete',
    );
    await user.click(del as HTMLElement);
    await waitFor(async () => {
      expect((await vault.list()).some((f) => f.key === 'member_id')).toBe(false);
    });
  });

  it('adds a new fact with a key derived from the label', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByDisplayValue('Maya Chen');
    await user.type(screen.getByLabelText('New fact label'), 'Pharmacy account');
    await user.type(screen.getByLabelText('New fact value'), 'PA-4471');
    await user.click(screen.getByRole('button', { name: 'Add fact' }));
    await waitFor(async () => {
      const facts = await vault.list();
      expect(facts.find((f) => f.label === 'Pharmacy account')).toMatchObject({
        key: 'pharmacy_account',
        value: 'PA-4471',
      });
    });
  });

  it('caps the vault at 20 facts: disables Add fact and shows a note at the limit', async () => {
    for (let i = 0; i < MAX_FACTS; i++) {
      await vault.save({ key: `fact_${i}`, label: `Fact ${i}`, value: `value ${i}` });
    }
    expect(await vault.list()).toHaveLength(MAX_FACTS);
    renderPage();

    expect(await screen.findByLabelText('New fact label')).toBeDisabled();
    expect(screen.getByLabelText('New fact value')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add fact' })).toBeDisabled();
    expect(
      screen.getByText(`You’ve reached the ${MAX_FACTS}-fact limit. Delete one to add another.`),
    ).toBeInTheDocument();
  });
});
