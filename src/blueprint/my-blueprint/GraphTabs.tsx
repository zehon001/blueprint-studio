/**
 * 蓝图编辑器内部图签（主图 + 局部函数）
 *
 * 主图固定在首位；其余图（局部函数）紧随其后。图签随资产来源切换图标：
 *  - 蓝图资产：主图使用蓝图图标；
 *  - 内置库 / 项目库函数资产：主图使用对应作用域的「f」徽标；
 *  - 局部函数：统一使用局部函数「f」徽标（颜色沿用 --fn-local）。
 *
 * 本组件不 import CSS：样式在 my-blueprint.css。
 */
import { useRef, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { Icon } from '../../shell/ui/Icon';
import { FnBadge, type FnScope } from '../../shell/ui/FnBadge';
import { assetIconFor } from '../../shell/ui/icons';
import { useBlueprintStore } from '../store/blueprint-store';
import { nextFunctionName, orderedGraphNames } from './model';

/** 图签主入口类型：蓝图 / 内置库函数 / 项目库函数 */
export type GraphTabsScope = 'blueprint' | 'builtin' | 'project';

export interface GraphTabsProps {
  className?: string;
  allowAdd?: boolean;
  scope?: GraphTabsScope;
  /** 图签栏右侧操作区（运行 / 保存等） */
  actions?: ReactNode;
}

const SCOPE_LABEL: Readonly<Record<GraphTabsScope, string>> = {
  blueprint: '主图',
  builtin: '内置库函数',
  project: '项目库函数',
};

export function GraphTabs({
  className,
  allowAdd = true,
  scope = 'blueprint',
  actions,
}: GraphTabsProps) {
  const asset = useBlueprintStore((s) => s.asset);
  const graphName = useBlueprintStore((s) => s.graphName);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  /** 提交 / 取消只触发其一（Esc 取消后的 blur 不再提交） */
  const settledRef = useRef(false);

  if (!asset) return null;

  const names = orderedGraphNames(asset);
  const blueprintSpec = assetIconFor('blueprint');
  const entryBadgeScope: FnScope | null = scope === 'blueprint' ? null : scope;

  const startAdd = (): void => {
    settledRef.current = false;
    setDraft(nextFunctionName(Object.keys(asset.graphs)));
    setDuplicate(false);
    setAdding(true);
  };

  const commitAdd = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    const name = draft.trim();
    if (name === '') {
      setAdding(false);
      return;
    }
    const st = useBlueprintStore.getState();
    if (st.addFunction(name)) {
      st.switchGraph(name);
      setAdding(false);
      setDraft('');
    } else {
      settledRef.current = false; // 重名：保持输入态（store 已弹提示）
      setDuplicate(true);
    }
  };

  const cancelAdd = (): void => {
    if (settledRef.current) return;
    settledRef.current = true;
    setAdding(false);
  };

  return (
    <div className={`bp-mb-tabs${className ? ` ${className}` : ''}`}>
      <div className="bp-mb-tabs-list" role="tablist" aria-label="图切换">
        {names.map((name) => {
          const isEntry = name === asset.entry;
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={name === graphName}
              className={`bp-mb-tab${name === graphName ? ' bp-mb-tab--active' : ''}${
                isEntry ? ' bp-mb-tab--entry' : ''
              }`}
              title={isEntry ? `${SCOPE_LABEL[scope]}「${name}」` : `局部函数「${name}」`}
              onClick={() => useBlueprintStore.getState().switchGraph(name)}
            >
              <span className="bp-mb-tab-icon" aria-hidden>
                {isEntry && entryBadgeScope === null ? (
                  <Icon icon={blueprintSpec.icon} size={13} style={{ color: blueprintSpec.color }} />
                ) : (
                  <FnBadge
                    scope={isEntry ? entryBadgeScope! : 'local'}
                    title={isEntry ? SCOPE_LABEL[scope] : '局部函数'}
                  />
                )}
              </span>
              {name}
            </button>
          );
        })}
        {adding ? (
          <input
            className="bp-mb-tabs-add-input"
            value={draft}
            placeholder="函数名"
            aria-label="新函数名"
            autoFocus
            onChange={(e) => {
              setDraft(e.target.value);
              setDuplicate(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAdd();
              else if (e.key === 'Escape') cancelAdd();
              e.stopPropagation();
            }}
            onBlur={commitAdd}
          />
        ) : allowAdd ? (
          <button type="button" className="bp-mb-tab bp-mb-tab--add" title="新建局部函数" onClick={startAdd}>
            <Icon icon={Plus} size={12} /> 函数
          </button>
        ) : null}
        {duplicate ? <span className="bp-mb-tabs-warn">名称已存在</span> : null}
      </div>
      {actions ? <div className="bp-mb-tabs-actions">{actions}</div> : null}
    </div>
  );
}
