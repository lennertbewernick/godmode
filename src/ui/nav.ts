/**
 * The app's section navigation, and the rule for when the workout row is shown.
 *
 * Nothing here reads the DOM, `window`, or storage, and nothing here touches IndexedDB. Every
 * input arrives as a parameter, so the rule can be pinned by a test rather than by clicking
 * through the app. The tab *position* (its localStorage round-trip) stays in App.tsx, because
 * that is a stored preference and an effect, not a rule.
 */

export type Tab = 'today' | 'history' | 'settings';

export const TABS: readonly Tab[] = ['today', 'history', 'settings'];

/**
 * Should the workout row — the tabs plus the add button — render above the content?
 *
 * The threshold is `>= 1`, deliberately, and it used to be `> 1`. Do not "restore" it. The row
 * now carries the only route to adding a workout, so hiding it from a user who has exactly one
 * would strand them there permanently: no switcher, and no way to reach a second exercise.
 * The lone chip also names the exercise every number on the screen is scoped to, which is
 * worth stating even when there is nothing to switch to.
 *
 * Settings is excluded because it lists the active workouts in its own card. The row above it
 * would repeat that fact in a second vocabulary, and the add control it hosts came from that
 * very card.
 */
export function shouldShowWorkoutBar(input: { tab: Tab; activeCount: number }): boolean {
  return input.activeCount >= 1 && input.tab !== 'settings';
}
