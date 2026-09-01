import type { Subscriber, Unsubscribe } from './types.ts'

/** Добавляет подписчика в список, создавая его при первом подписавшемся. */
export function appendSubscriber<T>(
  list: Subscriber<T>[] | null,
  subscriber: Subscriber<T>,
): Subscriber<T>[] {
  if (list === null) return [subscriber]
  list.push(subscriber)
  return list
}

/** Добавляет элемент, если его ещё нет в списке. */
export function pushUnique<T>(list: T[], item: T): void {
  if (!list.includes(item)) list.push(item)
}

/** Вызывает все функции отписки и очищает список. */
export function detachAll(subscriptions: Unsubscribe[]): void {
  for (const unsubscribe of subscriptions) unsubscribe()
  subscriptions.length = 0
}
