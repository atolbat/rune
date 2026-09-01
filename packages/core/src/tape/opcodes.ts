// Опкоды ленты: кадр = BeginPass, набор Draw, EndPass. SoA-колонки.
// BindTarget переключает цель между Draw (постпроцессинг): a = targetId
// (0 = канвас), b = очистить цель (0/1). Часть журнала — переносима между
// бэкендами, как и остальные опкоды.

export const OpCode = {
  BeginPass: 1,
  Draw: 2,
  EndPass: 3,
  BindTarget: 4,
} as const

export type OpCodeValue = (typeof OpCode)[keyof typeof OpCode]
