/**
 * Blueprint Studio v2 —— IR 解释器公共出口（T2.5）
 *
 * T2.6（绑定运行）/ T5.1（事件总线）/ T5.4（调试探针 WS）一律从这里 import，
 * 运行契约类型真源在 src/ir/types.ts，解释器自身契约在 ./types.ts。
 */
export { createRuntime } from './interpreter';
export type { DebugEvent, DebugEventKind, RuntimeHandle, RuntimeOptions } from './types';
