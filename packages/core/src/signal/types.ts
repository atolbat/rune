// Public reactivity types (the world sees only read and subscribe).

export interface ReadableSignal<T = unknown> {
  readonly value: T
  peek(): T
  subscribe(fn: (value: T) => void): () => void
  readonly version: number
}

export type Subscriber<T> = (value: T) => void
export type Unsubscribe = () => void
