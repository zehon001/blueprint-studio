/**
 * Blueprint Studio v2 —— 蓝图图签（T2.3，PLAN §8.3「图以 tabs 切换，含＋函数」）
 *
 * 蓝图编辑器顶部的图切换条：主图置首 + 函数子图 + 「＋函数」快捷新建；
 * 与 store 的当前图名（graphName）联动，My Blueprint 列表双击条目也会切图。
 * 本组件不 import 样式（node:test 可挂载冒烟）：样式在 my-blueprint.css。
 */
import { useRef, useState } from 'react';
import { useBlueprintStore } from '../store/blueprint-store';
import { nextFunctionName, orderedGraphNames } from './model';

export function GraphTabs({ className }: { className?: string }) {
  const asset = useBlueprintStore((s) => s.asset);
  const graphName = useBlueprintStore((s) => s.graphName);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [duplicate, setDuplicate] = useState(false);
  /** 提交 / 取消只触发其一（Esc 取消后的 blur 不再提交） */
  const settledRef = useRef(false);

  if (!asset) return null;

  const names = orderedGraphNames(asset);

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
    <div className={`bp-mb-tabs${className ? ` ${className}` : ''}`} role="tablist" aria-label="图切换">
      {names.map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          aria-selected={name === graphName}
          className={`bp-mb-tab${name === graphName ? ' bp-mb-tab--active' : ''}${
            name === asset.entry ? ' bp-mb-tab--entry' : ''
          }`}
          title={name === asset.entry ? `主图「${name}」` : `函数「${name}」`}
          onClick={() => useBlueprintStore.getState().switchGraph(name)}
        >
          {name}
        </button>
      ))}
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
      ) : (
        <button type="button" className="bp-mb-tab bp-mb-tab--add" title="新建函数" onClick={startAdd}>
          ＋函数
        </button>
      )}
      {duplicate ? <span className="bp-mb-tabs-warn">名称已存在</span> : null}
    </div>
  );
}
