// @rune/tape — recording tapes in workers without a GPU and replaying on the owner.
// M5 of the roadmap: stub tapes, frame delivery, cross-world replay.

export { createStub } from './stub.ts'
export type { TapeStub, RemoteFrame, ShipMode } from './stub.ts'

export { createTapePlayer } from './player.ts'
export type { TapePlayer, TapePlayerDeps } from './player.ts'
