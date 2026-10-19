/**
 * Blueprint Studio v2 —— 保存校验条（T2.2，PLAN §8.5「保存即校验」）
 *
 * 底部错误列表条：Ctrl+S 校验后显示 错误 / 警告 汇总 + 可展开明细；
 * 点击条目 → 切图 + 选中 + 居中节点（BlueprintEditorPanel 接 jumpToNode）。
 * 有错误时保存被阻止（onSave 不会被调用）；警告不阻止保存。
 * 样式由 BlueprintEditorPanel 统一 import（node:test 环境无法加载 .css）。
 */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Icon } from '../../shell/ui/Icon';
import type { ValidationIssue } from '../../ir/validate';

export interface ValidationBarProps {
  /** 最近一次校验结果（null = 尚未校验） */
  issues: ValidationIssue[] | null;
  /** 脏标记（保存状态圆点） */
  dirty: boolean;
  /** 当前图名（跨图 issue 显示来源图签） */
  graphName: string;
  /** 点击条目跳转（仅带 nodeId / edgeId 的条目可点） */
  onJump: (issue: ValidationIssue) => void;
  /** 保存（Ctrl+S 同一入口；有错误时由面板层阻止） */
  onSave: () => void;
}

export function ValidationBar({ issues, dirty, graphName, onJump, onSave }: ValidationBarProps) {
  const [expanded, setExpanded] = useState(false);
  const errors = issues?.filter((i) => i.severity === 'error') ?? [];
  const warnings = issues?.filter((i) => i.severity === 'warning') ?? [];

  // 校验出错误时自动展开（保存被阻止 → 引导用户看错误）
  useEffect(() => {
    if (issues && errors.length > 0) setExpanded(true);
    // eslint 依赖仅为 issues 引用变化；errors 为派生值不单独依赖
  }, [issues]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusText =
    issues === null
      ? dirty
        ? '未保存（Ctrl+S 保存并校验）'
        : '已保存'
      : errors.length === 0
        ? warnings.length === 0
          ? '校验通过，无错误无警告'
          : `校验通过，${warnings.length} 条警告`
        : `${errors.length} 个错误 · ${warnings.length} 条警告（保存被阻止）`;

  const dotClass = issues && errors.length > 0 ? 'bp-valbar-dot--error' : dirty ? 'bp-valbar-dot--dirty' : 'bp-valbar-dot--saved';

  return (
    <div className="bp-valbar">
      <div className="bp-valbar-summary">
        <span className={`bp-valbar-dot ${dotClass}`} aria-hidden="true" />
        <span className="bp-valbar-text" title={statusText}>
          {statusText}
        </span>
        {issues && issues.length > 0 ? (
          <button
            type="button"
            className="bp-valbar-toggle"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? '收起明细' : '展开明细'}
          >
            <Icon icon={expanded ? ChevronDown : ChevronRight} size={12} />
            {expanded ? '收起' : '明细'}
          </button>
        ) : null}
        <button type="button" className="bp-valbar-btn" onClick={onSave} title="校验并保存（Ctrl+S）">
          保存（Ctrl+S）
        </button>
      </div>
      {expanded && issues && issues.length > 0 ? (
        <div className="bp-valbar-list" role="list">
          {issues.map((issue, index) => {
            const jumpable = issue.nodeId !== undefined || issue.edgeId !== undefined;
            return (
              <div
                key={`${issue.graphName}-${issue.code}-${issue.nodeId ?? ''}-${issue.edgeId ?? ''}-${index}`}
                role={jumpable ? 'listitem' : undefined}
                className={`bp-valbar-row${jumpable ? ' bp-valbar-row--jump' : ''}`}
                onClick={jumpable ? () => onJump(issue) : undefined}
                title={jumpable ? '点击跳转到对应节点' : undefined}
              >
                <span className={`bp-valbar-severity bp-valbar-severity--${issue.severity}`}>
                  {issue.severity === 'error' ? '错误' : '警告'}
                </span>
                {issue.graphName && issue.graphName !== graphName ? (
                  <span className="bp-valbar-graph">{issue.graphName}</span>
                ) : null}
                <span className="bp-valbar-message">{issue.message}</span>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
