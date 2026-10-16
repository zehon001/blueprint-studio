/**
 * Blueprint Studio v2 —— 事件总线内部标记键（T5.1 · PLAN §11）
 *
 * 叶子模块（零依赖）：src/nodes/events.ts（Nodes 层，写入 target 标记）与事件总线
 * （Runtime 层，读取并剥离）共用这些键。独立成文件避免 nodes → runtime → nodes
 * 的模块环（解释器已反向依赖 @/nodes/spec）。
 *
 * 标记随事件参数（args）携带，与 T2.6 BlueprintEventHub 的 __bpHubEcho 同一先例：
 * 接收实例的 event.listen args 输出脚会看到这些键（总线投递时注入的回执令牌），
 * 业务蓝图按名取具名参数不受影响。
 */

/** event.send 的 target 引脚值（'node' | 'all'；'ui' 为默认不写标记）随 args 携带，总线读取后剥离 */
export const BUS_TARGET_KEY = '__bpBusTarget';

/** 总线投递时注入的回执令牌：接收实例出队回灌（onDebug 'emit'）时总线据此识别「自投递回声」并吞掉 */
export const BUS_ECHO_KEY = '__bpBusEcho';
