import type { Subscriber, Unsubscribe } from './types.ts'

/** Appends a subscriber to the list, creating it on the first subscriber. */
export function appendSubscriber<T>(
  list: Subscriber<T>[] | null,
  subscriber: Subscriber<T>,
): Subscriber<T>[] {
  if (list === null) return [subscriber]
  list.push(subscriber)
  return list
}

/** Appends an item if it is not yet in the list. */
export function pushUnique<T>(list: T[], item: T): void {
  if (!list.includes(item)) list.push(item)
}

/** Calls every unsubscribe function and clears the list. */
export function detachAll(subscriptions: Unsubscribe[]): void {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions.length = 0
}
