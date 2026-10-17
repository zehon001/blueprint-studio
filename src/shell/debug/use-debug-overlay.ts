/**
 * Blueprint Studio v2 —— 运行时蓝图观察·编辑器侧订阅钩子（T5.4，PLAN §12）
 *
 * useDebugOverlay({ enabled, assetPath })：
 *  - enabled（默认开，observe-toggle 持久化）→ 经共享 WS 客户端发 debug.subscribe
 *    （project 取工作区当前项目；assetPath = 本面板蓝图）；关闭 / 卸载发
 *    debug.unsubscribe（一键关闭观察的传播链起点——服务端随后 mute 运行窗口）；
 *  - WS 断线自动重连（指数退避上限 5s，见 debug-ws.ts）；重连成功自动重发订阅；
 *  - debug.batch → applyDebugEvents 折叠 → **每批一次 setState**（不逐事件）；
 *    端口值只留每引脚最新；衰减靠时间戳惰性清理（250ms 扫描 tick，仅叠加非空时）；
 *  - nodeError → toast（复用蓝图 store 的轻提示；同节点同消息 2s 内只报一次）。
 *
 * 返回的状态供 BlueprintEditorPanel 做受控 nodes/edges 映射（applyNodeOverlay /
 * applyEdgeOverlay 纯函数）与端口值徽标层（DebugPinValues）渲染。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { DebugEvent } from '../../runtime/interpreter/types';
import { useBlueprintStore } from '../../blueprint/store/blueprint-store';
import { useWorkspaceStore } from '../workspace-store';
import { sharedDebugWs } from './debug-ws';
import type { DebugServerMessage } from './protocol';
import {
  applyDebugEvents,
  emptyOverlayState,
  isOverlayEmpty,
  type DebugOverlayState,
} from './overlay-state';

/** 叠加层衰减扫描周期（惰性清理的驱动 tick；非批处理节流） */
const DECAY_SWEEP_MS = 250;
/** 错误 toast 去重窗口（同节点同消息 2s 内只报一次） */
export const ERROR_TOAST_DEDUPE_MS = 2000;

/** useDebugOverlay 参数 */
export interface UseDebugOverlayOptions {
  /** 观察开关（默认开；关闭 = 发 unsubscribe 并清空叠加状态） */
  enabled: boolean;
  /** 观察的蓝图资产路径（如 'logic/main.bp.json'；空 = 不订阅） */
  assetPath?: string;
  /** 订阅的资产路径集合（缺省 = [assetPath]；同项目多图扩展位） */
  assetPaths?: readonly string[];
  /**
   * 事件折叠上下文（随批使用最新值，经 ref 透传——不进订阅 effect 依赖，避免
   * 画布每次连线 / 切图都重发 subscribe）：inExecEdges + graphName 见 FoldContext。
   */
  foldContext?: { inExecEdges?: ReadonlyMap<string, readonly string[]>; graphName?: string };
}

/** useDebugOverlay 返回 */
export interface DebugOverlayApi {
  /** 叠加状态（每 WS 批一个新对象；空闲期间保持原引用） */
  state: DebugOverlayState;
  /** 衰减扫描 tick（惰性衰减的重渲染驱动；渲染映射的 now 基准配套） */
  tick: number;
  /** WS 是否已连接（叠加层状态指示用） */
  connected: boolean;
  /** 观察是否生效（enabled + assetPath/project 就绪） */
  active: boolean;
}

export function useDebugOverlay({
  enabled,
  assetPath,
  assetPaths,
  foldContext,
}: UseDebugOverlayOptions): DebugOverlayApi {
  const project = useWorkspaceStore((s) => s.currentProject?.name ?? null);
  const paths = useMemo(
    () => (assetPaths ?? (assetPath ? [assetPath] : [])).filter((p) => p !== ''),
    [assetPath, assetPaths],
  );
  const active = enabled && paths.length > 0 && !!project;

  const [state, setState] = useState<DebugOverlayState>(emptyOverlayState);
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  /** 错误 toast 去重表（'assetPath:graph:nodeId:message' → 上次 toast 时刻） */
  const lastToastAtRef = useRef(new Map<string, number>());
  /** 折叠上下文最新值（每渲染同步；WS 订阅 effect 经 ref 读取，不成为其依赖） */
  const foldRef = useRef(foldContext);
  foldRef.current = foldContext;

  /* —— WS 订阅生命周期：启用 → subscribe；关闭 / 卸载 / 参数变化 → unsubscribe —— */

  useEffect(() => {
    if (!active || !project) return;
    const ws = sharedDebugWs();
    const sendSubscribe = (): void => {
      ws.send({ type: 'debug.subscribe', project, assetPaths: [...paths] });
    };
    sendSubscribe();
    setConnected(ws.connected);
    // 多面板共享一条连接：事件经 addListener 多播；onOpen 重发订阅（重连后服务端订阅表已清空）
    const unsubscribeWs = ws.addListener({
      onOpen: () => {
        setConnected(true);
        sendSubscribe();
      },
      onClose: () => setConnected(false),
      onMessage: (msg) =>
        debugOverlayHandleMessage(
          msg,
          setState,
          lastToastAtRef.current,
          project,
          paths,
          foldRef.current,
        ),
    });
    return () => {
      unsubscribeWs();
      ws.send({ type: 'debug.unsubscribe', project, assetPaths: [...paths] });
    };
  }, [active, project, paths]);

  /* —— 惰性衰减扫描：叠加非空才推进 tick（空闲零开销；state 经 ref 读取避免重挂监听） —— */

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      if (isOverlayEmpty(stateRef.current)) return;
      setTick((t) => t + 1);
    }, DECAY_SWEEP_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  /* —— 关闭观察 / 上下文缺失：清空叠加状态（静默降级） —— */

  useEffect(() => {
    if (active) return;
    setState(emptyOverlayState());
    setConnected(false);
  }, [active]);

  return { state, tick, connected, active };
}

/**
 * 批处理消息（独立函数，单测可直接调用）：debug.batch → 折叠 → 单次 setState；
 * nodeError → toast（复用蓝图 store 轻提示，2s 去重防风暴）。
 * 只认订阅过的通道（服务端已按通道匹配，此处双保险）。
 */
export function debugOverlayHandleMessage(
  msg: DebugServerMessage,
  setState: (updater: (prev: DebugOverlayState) => DebugOverlayState) => void,
  lastToastAt: Map<string, number>,
  project: string,
  paths: readonly string[],
  foldContext?: { inExecEdges?: ReadonlyMap<string, readonly string[]>; graphName?: string },
): void {
  if (msg.type !== 'debug.batch') return;
  if (msg.project !== project || !paths.includes(msg.assetPath)) return;
  const events = (Array.isArray(msg.events) ? msg.events : []) as DebugEvent[];
  if (events.length === 0) return;
  const now = Date.now();
  setState((prev) => applyDebugEvents(prev, events, { now, ...foldContext }));
  for (const ev of events) {
    if (ev.kind !== 'nodeError' || !ev.nodeId) continue;
    const key = `${msg.assetPath}:${ev.graph}:${ev.nodeId}:${ev.message ?? ''}`;
    const last = lastToastAt.get(key) ?? 0;
    if (now - last < ERROR_TOAST_DEDUPE_MS) continue;
    lastToastAt.set(key, now);
    useBlueprintStore.getState().notify(
      `节点执行出错：${ev.message ?? '未知错误'}（${ev.nodeId}）`,
      'error',
    );
  }
}
