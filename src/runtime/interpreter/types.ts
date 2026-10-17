/**
 * Blueprint Studio v2 —— IR 解释器对外契约（T2.5）
 *
 * 本文件只声明解释器对外的三个类型，运行契约真源仍在 src/ir/types.ts：
 *  - DebugEvent    ：调试探针事件（T5.4 运行时蓝图观察经 WS 消费；逐条同步发出，批量节流在消费方做）
 *  - RuntimeOptions：createRuntime 的可选项（调试回调 / print 旁路 / ADR-005 句柄注入 / 变量初值）
 *  - RuntimeHandle ：运行实例句柄（T2.6 绑定运行 / T5.1 事件总线接线面）
 */
import type { UiHandle } from '@/ir/types';

/** 调试探针事件种类 */
export type DebugEventKind =
  | 'nodeEnter' // 即将执行某节点（含纯节点按需求值）
  | 'nodeExit' // 节点执行完成（抛错时不发，改发 nodeError）
  | 'pinValue' // 输出引脚实时值（T5.4 数据端口观察）
  | 'emit' // 一个事件出队并开始分发（message = 事件名，value = 事件参数）
  | 'nodeError'; // 节点执行出错（message = 错误消息）

/** 调试探针事件（T5.4 接 WS；逐条同步发出，不排队） */
export interface DebugEvent {
  /** 事件种类 */
  kind: DebugEventKind;
  /** 所属图名（函数调用时为子图名） */
  graph: string;
  /** 节点实例 id（emit 事件无） */
  nodeId?: string;
  /** 引脚 id（仅 pinValue） */
  pinId?: string;
  /** 值（pinValue = 引脚值；emit = 事件参数对象） */
  value?: unknown;
  /** 消息（emit = 事件名；nodeError = 错误消息） */
  message?: string;
  /** 时间戳（epoch 毫秒） */
  ts: number;
}

/** createRuntime 可选项 */
export interface RuntimeOptions {
  /** 调试探针（T5.4）：逐条同步回调，消费方自行批量节流 */
  onDebug?: (ev: DebugEvent) => void;
  /** 节点错误上报（旁路直调，不入事件队列）：链在此终止，队列继续下一事件 */
  onError?: (err: Error, graphName: string, nodeId: string) => void;
  /**
   * 打印旁路（ctx.print 直调回调，不入事件队列——事件链 await 期间也能输出）。
   * 不提供时 print 静默丢弃；T2.6 运行窗口据此接控制台面板。
   */
  onPrint?: (...parts: unknown[]) => void;
  /** UI 访问器（ADR-005，T2.6 绑定 UI 后注入；缺失时 ui.* 节点自行降级） */
  ui?: UiHandle;
  /** 系统通知钩子（system.notify 用，透传进 ctx） */
  notify?: (message: string) => void;
  /** 剪贴板写入钩子（system.clipboardWrite 用，透传进 ctx） */
  clipboardWrite?: (text: string) => void;
  /** 打开链接钩子（system.openUrl 用，透传进 ctx） */
  openUrl?: (url: string) => void;
  /** 变量初值覆盖（键 = IRVariable.name；未声明变量名也会写入存储，显式提供即视为已知） */
  vars?: Record<string, unknown>;
  /** 单条事件链的最大执行步数（死循环保护；默认 100000，v1.1 为 5000——循环状态机链尾回连会合法地多次经过节点，故放宽） */
  maxStepsPerChain?: number;
}

/** 运行实例句柄（createRuntime 返回） */
export interface RuntimeHandle {
  /** 启动运行：复位队落后触发 start 事件（event.start 节点，BeginPlay 同义）；重复调用抛错 */
  start(): void;
  /**
   * 停止运行：清空事件队列、中止 ctx.signal（挂起的 ctx.delay 以 AbortError reject）、
   * 调用 clearAllStateSlots() 复位循环/序列/定时器状态机（ADR-005）。幂等。
   */
  stop(): void;
  /**
   * 发送事件：入串行事件队列 FIFO 保序消费（PLAN §11 / v1.1 语义）；
   * 处理中再 emit 排队不递归；未启动时静默丢弃。
   */
  emit(name: string, args?: Record<string, unknown>): void;
  /**
   * 直接调用函数图（不走事件队列，随调随执行）：压独立栈帧，返回
   * { 返回值名: 值 } 记录；子图缺失 / 递归超限 / 未启动时 reject
   *（错误回调由调用方或事件链边界统一上报，此处不重复调 onError）。
   */
  callGraph(name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** 读资产变量（未声明且未写入过返回 undefined） */
  getVar(name: string): unknown;
  /** 写资产变量（与所有 ctx 共享同一存储） */
  setVar(name: string, value: unknown): void;
  /** 是否运行中（start 后 true，stop 后 false） */
  readonly isRunning: boolean;
}
