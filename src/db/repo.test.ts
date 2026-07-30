import { beforeEach, describe, expect, it } from 'vitest';
import { pushupParams } from '../core/patterns/percentageRamp.js';
import type { Baseline } from '../core/types.js';
import {
  __setDB,
  createChallenge,
  createExercise,
  endChallenge,
  exerciseLabels,
  listActiveChallenges,
  resolveSelectedChallenge,
  saveSettings,
} from './repo.js';
import { openFitnessDB } from './schema.js';

let dbCounter = 0;
beforeEach(() => {
  dbCounter += 1;
  __setDB(openFitnessDB(`repo-test-db-${dbCounter}`));
});

const baseline = (value: number): Baseline => ({
  value,
  source: 'tested',
  recordedAt: new Date(2026, 0, 1).toISOString(),
});

async function addWorkout(label: string, baselineMax: number, goal: number) {
  const exercise = await createExercise(label);
  const { challenge } = await createChallenge({
    exerciseId: exercise.id,
    baseline: baseline(baselineMax),
    params: pushupParams(baselineMax, goal),
  });
  return { exercise, challenge };
}

describe('more than one active workout', () => {
  it('lists every active challenge, newest first', async () => {
    const first = await addWorkout('Push-ups', 18, 100);
    const second = await addWorkout('Pull-ups', 5, 20);

    const active = await listActiveChallenges();
    expect(active.map((c) => c.id)).toEqual([second.challenge.id, first.challenge.id]);
  });

  it('leaves an ended challenge out of the active list', async () => {
    const first = await addWorkout('Push-ups', 18, 100);
    await addWorkout('Pull-ups', 5, 20);
    await endChallenge(first.challenge.id, 'closed_manually');

    const active = await listActiveChallenges();
    expect(active.map((c) => c.id)).not.toContain(first.challenge.id);
    expect(active).toHaveLength(1);
  });

  it('resolves the stored selection rather than simply the newest', async () => {
    const first = await addWorkout('Push-ups', 18, 100);
    await addWorkout('Pull-ups', 5, 20);
    await saveSettings({ selectedChallengeId: first.challenge.id });

    expect((await resolveSelectedChallenge())?.id).toBe(first.challenge.id);
  });

  it('falls back to the newest when nothing is selected', async () => {
    await addWorkout('Push-ups', 18, 100);
    const second = await addWorkout('Pull-ups', 5, 20);

    expect((await resolveSelectedChallenge())?.id).toBe(second.challenge.id);
  });

  it('falls back rather than stranding the user when the selection has ended', async () => {
    // The case that would otherwise show an empty screen with the data still there: the
    // selected workout was ended, or a backup from another device named a challenge that
    // does not exist here.
    const first = await addWorkout('Push-ups', 18, 100);
    const second = await addWorkout('Pull-ups', 5, 20);
    await saveSettings({ selectedChallengeId: first.challenge.id });
    await endChallenge(first.challenge.id, 'closed_manually');

    expect((await resolveSelectedChallenge())?.id).toBe(second.challenge.id);
  });

  it('falls back when the selection names a challenge that does not exist at all', async () => {
    const only = await addWorkout('Push-ups', 18, 100);
    await saveSettings({ selectedChallengeId: 'ch_from-another-device' });

    expect((await resolveSelectedChallenge())?.id).toBe(only.challenge.id);
  });

  it('returns nothing when there is genuinely no active challenge', async () => {
    const only = await addWorkout('Push-ups', 18, 100);
    await endChallenge(only.challenge.id, 'closed_manually');

    expect(await resolveSelectedChallenge()).toBeUndefined();
  });

  it('labels each challenge by its exercise', async () => {
    const push = await addWorkout('Push-ups', 18, 100);
    const pull = await addWorkout('Pull-ups', 5, 20);

    const labels = await exerciseLabels(await listActiveChallenges());
    expect(labels.get(push.exercise.id)).toBe('Push-ups');
    expect(labels.get(pull.exercise.id)).toBe('Pull-ups');
  });

  it('gives two exercises separate chains, so their histories never merge', async () => {
    const push = await addWorkout('Push-ups', 18, 100);
    const pull = await addWorkout('Pull-ups', 5, 20);

    expect(push.challenge.chainId).not.toBe(pull.challenge.chainId);
  });
});
