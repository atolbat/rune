// @rune/tape — запись лент в воркерах без GPU и проигрывание на владельце.
// M5 дорожной карты: stub-ленты, доставка кадров, кросс-мировой replay.

export { createStub } from './stub.ts'
export type { TapeStub, RemoteFrame, ShipMode } from './stub.ts'

export { createTapePlayer } from './player.ts'
export type { TapePlayer, TapePlayerDeps } from './player.ts'
