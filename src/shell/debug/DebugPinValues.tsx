/**
 * Blueprint Studio v2 —— 端口实时值徽标层（T5.4 · 最小实现）
 *
 * 选中节点的**输出引脚实时值**显示在节点正下方（叠加 DOM 层，按 nodeId 定位；
 * 值 5s 未更新消失——decay 由父级以 tick 传入 now 完成惰性清理）。经
 * ViewportPortal 渲染进画布视口（随平移缩放同步，CommentLayer 同模式）；
 * pointer-events 关闭，不干扰画布交互。
 *
 * 值来源：useDebugOverlay 折叠出的 pinValues（'nodeId:pinId' → 最新值）；
 * 引脚清单取自当前图 IR + spec（只显示有实时值的输出引脚，按 spec 顺序）。
 */
import { ViewportPortal, useStore } from '@xyflow/react';
import type { ReactFlowState } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { useBlueprintStore } from '../../blueprint/store/blueprint-store';
import { PIN_TTL_MS, type DebugOverlayState } from './overlay-state';

/** 值文本化（对象 / 数组 JSON；长串截断） */
export function formatPinValue(value: unknown, maxLen = 42): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  let text: string;
  if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean') text = String(value);
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

/** DebugPinValues 参数 */
export interface DebugPinValuesProps {
  /** 叠加状态（useDebugOverlay 折叠结果） */
  state: DebugOverlayState;
  /** 惰性衰减基准时间（父级 250ms tick 推进；Date.now() 直取会让过期值滞留） */
  tick: number;
}

/**
 * 端口实时值徽标层：选中的每个节点下方一行徽标（输出引脚 label: 值）。
 * 位置随节点拖动实时跟随（nodeLookup 经 useStore 订阅）。
 */
export function DebugPinValues({ state, tick }: DebugPinValuesProps) {
  void tick; // 仅作重渲染驱动（父级 tick 变化 → 过期徽标消失）
  const selection = useBlueprintStore((s) => s.selection.nodeIds);
  const graph = useBlueprintStore((s) => s.asset?.graphs[s.graphName] ?? null);
  const specs = useBlueprintStore((s) => s.specs);
  // nodeLookup 引用随节点变化（拖动 / 增删）——徽标位置实时跟随
  const nodeLookup = useStore((s: ReactFlowState) => s.nodeLookup);

  const badges: Array<{
    key: string;
    nodeId: string;
    x: number;
    y: number;
    rows: Array<{ pinId: string; label: string; text: string }>;
  }> = [];
  if (graph) {
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const nodeId of selection) {
      const irNode = nodeById.get(nodeId);
      if (!irNode) continue;
      const spec = specs.get(irNode.type) ?? null;
      const internal = nodeLookup.get(nodeId);
      if (!internal) continue;
      const pos = internal.internals.positionAbsolute;
      const height = internal.measured?.height ?? 96;
      const rows: Array<{ pinId: string; label: string; text: string }> = [];
      for (const pin of spec?.outputs ?? []) {
        if (pin.type === 'exec') continue;
        const entry = state.pinValues.get(`${nodeId}:${pin.id}`);
        if (!entry) continue;
        if (Date.now() - entry.ts > PIN_TTL_MS) continue; // 5s 未更新消失（惰性）
        rows.push({ pinId: pin.id, label: pin.label ?? pin.id, text: formatPinValue(entry.value) });
      }
      if (rows.length === 0) continue;
      badges.push({ key: nodeId, nodeId, x: pos.x, y: pos.y + height + 6, rows });
    }
  }

  if (badges.length === 0) return null;
  return (
    <ViewportPortal>
      <div className="bp-debug-pin-layer">
        {badges.map((badge) => (
          <div
            key={badge.key}
            className="bp-debug-pin"
            style={{ left: badge.x, top: badge.y } as CSSProperties}
          >
            {badge.rows.map((row) => (
              <span key={row.pinId} className="bp-debug-pin-row" title={`${row.label} = ${row.text}`}>
                <span className="bp-debug-pin-label">{row.label}</span>
                <span className="bp-debug-pin-value">{row.text}</span>
              </span>
            ))}
          </div>
        ))}
      </div>
    </ViewportPortal>
  );
}
