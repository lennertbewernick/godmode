import { describe, expect, it } from 'vitest';
import { shouldShowWorkoutBar } from './nav.js';

describe('shouldShowWorkoutBar', () => {
  it('shows the row on Today when there is a choice to make', () => {
    expect(shouldShowWorkoutBar({ tab: 'today', activeCount: 2 })).toBe(true);
  });

  it('shows the row on History, which is scoped to the selected workout too', () => {
    expect(shouldShowWorkoutBar({ tab: 'history', activeCount: 2 })).toBe(true);
  });

  it('hides the row on Settings, which lists the workouts itself', () => {
    // Settings is the inventory: it names every active workout in its own card. Repeating
    // the row above it would state the same fact in a second vocabulary, and the add control
    // that used to live in that card has moved onto the row precisely so there is one place.
    expect(shouldShowWorkoutBar({ tab: 'settings', activeCount: 2 })).toBe(false);
  });

  it('still shows the row with a single workout, because it is the only route to a second', () => {
    // The regression this whole change exists to fix. The old rule was `active.length > 1`,
    // so a user with one workout got no row — and once the add control lives on the row, no
    // way to ever reach a second. Do not "restore" the > 1 threshold.
    expect(shouldShowWorkoutBar({ tab: 'today', activeCount: 1 })).toBe(true);
  });

  it('is total: no workouts means no row, even though App returns Welcome first', () => {
    // Defensive. App renders Welcome before this site is reached, so zero should not arise;
    // the predicate answers anyway rather than depending on the caller's early return.
    expect(shouldShowWorkoutBar({ tab: 'today', activeCount: 0 })).toBe(false);
  });
});
