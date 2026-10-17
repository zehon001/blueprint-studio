/**
 * Blueprint Studio v2 —— 事件总线公共出口（T5.1）
 *
 * T5.2（事件面板）/ T5.4（运行时蓝图观察）/ T6.4（插件 CLI 桥）一律从这里 import：
 *  - createEventBus / EventBus：总线本体（四类源统一入队 + node/ui/all 目标路由 + 环保护）；
 *  - runtimeEventSink：解释器 onDebug → 总线回灌的接桥（BindingRunner / 运行窗口用）；
 *  - markers：与 src/nodes/events.ts（event.send target 引脚）共享的内部标记键。
 */
export {
  EventBus,
  createEventBus,
  runtimeEventSink,
} from './bus';
export type {
  RouteTarget,
  BusSourceKind,
  BusEventSource,
  BusDebugEvent,
  BusRuntimeRegistration,
  BusPushOptions,
  EventBusOptions,
  BusRegistrationSnapshot,
} from './bus';
export { BUS_TARGET_KEY, BUS_ECHO_KEY } from './markers';
