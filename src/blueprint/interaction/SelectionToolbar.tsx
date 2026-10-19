/**
 * Blueprint Studio v2 —— 选中工具条（T2.2，PLAN §8.2 第 5 条：对齐 / 分布）
 *
 * 选中 ≥ 2 个节点时浮出：左 / 上对齐 + 水平 / 垂直分布（≥ 3 个才可分布），
 * 结果吸附到最近 10px 网格（computeAlignedPositions 纯函数，store.moveNodes 落命令栈）。
 * 样式由 BlueprintEditorPanel 统一 import（node:test 环境无法加载 .css）。
 */
import type { AlignMode } from './logic';

export interface SelectionToolbarProps {
  /** 选中节点数（< 2 不渲染） */
  nodeCount: number;
  /** 执行对齐 / 分布（BlueprintEditorPanel 接 store.moveNodes） */
  onAlign: (mode: AlignMode) => void;
}

/** 工具条按钮清单（分布按钮需 ≥ 3 个节点） */
const ACTIONS: Array<{ mode: AlignMode; label: string; minNodes: number; title: string }> = [
  { mode: 'left', label: '左对齐', minNodes: 2, title: '左对齐（吸附 10px 网格）' },
  { mode: 'top', label: '上对齐', minNodes: 2, title: '上对齐（吸附 10px 网格）' },
  { mode: 'distribute-h', label: '水平分布', minNodes: 3, title: '水平均匀分布（吸附 10px 网格）' },
  { mode: 'distribute-v', label: '垂直分布', minNodes: 3, title: '垂直均匀分布（吸附 10px 网格）' },
];

export function SelectionToolbar({ nodeCount, onAlign }: SelectionToolbarProps) {
  if (nodeCount < 2) return null;
  return (
    <div className="bp-sel-toolbar" role="toolbar" aria-label="对齐工具条">
      <span className="bp-sel-toolbar-count">已选 {nodeCount} 个节点</span>
      {ACTIONS.map((action) => (
        <button
          key={action.mode}
          type="button"
          className="bp-sel-btn"
          disabled={nodeCount < action.minNodes}
          title={action.title}
          onClick={() => onAlign(action.mode)}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
}
