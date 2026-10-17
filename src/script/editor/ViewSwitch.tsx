/**
 * [蓝图 | 脚本] 视图切换条（T3.1 · 独立导出，T3.8 双视图同步协议直接复用）
 *
 * 职责：单一逻辑资产双视图（PLAN §10）的 segmented control。
 * 两态：'blueprint'（蓝图视图）/ 'script'（脚本视图）。
 * 脏标记互锁展示：脚本视图存在未保存草稿（scriptDirty）且当前在蓝图视图时，
 * 切换条旁显示提示「脚本有未保存修改」（仅提示，不阻止切换——保存者胜 /
 * 过期重载同步协议属 T3.8）。
 *
 * 注意：本组件不 import .css（node:test 需直接加载本文件；样式在 index.ts 统一挂）。
 */
export type ScriptViewKind = 'blueprint' | 'script'

export interface ViewSwitchProps {
  /** 当前视图 */
  view: ScriptViewKind
  /** 切换回调 */
  onChange: (view: ScriptViewKind) => void
  /** 脚本视图存在未保存草稿（蓝图视图上显示互锁提示） */
  scriptDirty?: boolean
  /** 禁用（如加载中） */
  disabled?: boolean
}

/** [蓝图 | 脚本] 切换条（含脚本脏标记互锁提示） */
export function ViewSwitch({ view, onChange, scriptDirty = false, disabled = false }: ViewSwitchProps) {
  return (
    <span className="script-view-switch">
      <span className="script-view-switch-group" role="tablist" aria-label="蓝图/脚本视图切换">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'blueprint'}
          disabled={disabled}
          className={`script-view-switch-btn${view === 'blueprint' ? ' is-active' : ''}`}
          onClick={() => onChange('blueprint')}
        >
          蓝图
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'script'}
          disabled={disabled}
          className={`script-view-switch-btn${view === 'script' ? ' is-active' : ''}`}
          onClick={() => onChange('script')}
        >
          脚本
        </button>
      </span>
      {/* 脏标记互锁提示（蓝图视图 + 脚本有未保存草稿时展示；仅提示不阻断） */}
      {view === 'blueprint' && scriptDirty ? (
        <span className="script-view-switch-dirty" role="status" title="保存者胜：切回脚本视图可继续编辑，蓝图信息基于最近已知文本">
          脚本有未保存修改
        </span>
      ) : null}
    </span>
  )
}
