import type { Unsubscribe } from './types.ts'

/** Calls every unsubscribe function and clears the list.
 *  (Task 181 removed the never-imported appendSubscriber / pushUnique —
 *  zero references across every package, test, and demo.) */
export function detachAll(subscriptions: Unsubscribe[]): void {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions.length = 0
}
