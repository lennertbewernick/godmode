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
 * The threshold is `>= 1`, deliberately, and it used to be `> 1`. Do not "restore" it.
 *
 * Two reasons were given for `>= 1`. As of 2026-07-30 only the second one is load-bearing:
 *
 *   SUSPENDED — the row carried the only route to adding a workout, so hiding it from a user
 *   with exactly one stranded them there permanently. `ADD_WORKOUT_ENABLED` in App.tsx is now
 *   false, so the row carries no such route and this reason currently proves nothing. It is
 *   suspended, not retired: turn that flag back on and it applies again exactly as written.
 *
 *   ACTIVE — the lone chip names the exercise that every number on the screen is scoped to.
 *   Worth stating even when there is nothing to switch to, and true regardless of the flag.
 *
 * So the threshold stands, on one reason instead of two. Anyone narrowing it to `> 1` should
 * be arguing against the active reason above, not assuming both lapsed with the button.
 *
 * Settings is excluded because it lists the active workouts in its own card. The row above it
 * would repeat that fact in a second vocabulary, and the add control it hosts came from that
 * very card.
 */
export function shouldShowWorkoutBar(input: { tab: Tab; activeCount: number }): boolean {
  return input.activeCount >= 1 && input.tab !== 'settings';
}
