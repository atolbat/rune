// Tape opcodes: frame = BeginPass, a set of Draw, EndPass. SoA columns.
// BindTarget switches the target between Draws (post-processing): a = targetId
// (0 = canvas), b = clear the target (0/1). Part of the journal — portable
// across backends, like the other opcodes.

export const OpCode = {
  BeginPass: 1,
  Draw: 2,
  EndPass: 3,
  BindTarget: 4,
} as const

export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode]
