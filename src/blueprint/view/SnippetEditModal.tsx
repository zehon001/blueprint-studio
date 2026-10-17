/**
 * Blueprint Studio v2 —— 片段编辑模态（T3.7，ADR-007 §5）
 *
 * 双击片段节点展开：源码 textarea + 引脚表（增删改行：id / 方向 / 类型 / 显示名）。
 * 叶子组件纪律（对齐 interaction 层）：不 import CSS / store，纯 props 驱动，
 * node:test（happy-dom）可直接挂载冒烟；命令栈接线在 saveSnippetEdit（本文件
 * 导出的模块级函数），面板 onSave 回调一行接通。
 *
 * 保存语义（saveSnippetEdit）：
 *  - 节点已引用片段 → 更新该 IRSnippet 的 code / pins（单命令，可撤销）；
 *  - 节点未引用片段（新建的空片段节点）→ 同一命令内分配 snipN id、创建 IRSnippet
 *    并回填节点 params.snippet（撤销一步整体还原）。
 */
import { useState } from 'react';
import type { Draft } from 'immer';
import { getDomainState, isDomainRegistered, runCommand } from '../../shell/commands';
import type { IRAsset, IRSnippet, IRSnippetPin } from '../../ir/types';
import { SNIPPET_PARAM_KEY } from '../../script/codegen-common';
import { SNIPPET_NODE_TYPE, uniqueSnippetId } from '../../script/snippet';
import { useBlueprintStore } from '../store/blueprint-store';

/** 命令栈 'blueprint' 域状态形状（与 store 的 BlueprintDomainState 一致；type-only 引用避免环） */
interface BlueprintDomainLike {
  asset: IRAsset;
}

/** 引脚可选类型（自由输入 + 常用类型快捷选择） */
const PIN_TYPE_OPTIONS: readonly string[] = [
  'any', 'bool', 'int', 'float', 'string', 'object', 'exec',
];

export interface SnippetEditModalProps {
  /** 待编辑片段（null = 新建：节点尚未引用片段，保存时创建） */
  snippet: IRSnippet | null;
  /** 模态标题（如「片段：snip1」/「新建脚本片段」） */
  title: string;
  /** 保存回调（面板接 saveSnippetEdit 入命令栈） */
  onSave: (code: string, pins: IRSnippetPin[]) => void;
  /** 取消回调（关闭模态，不落任何改动） */
  onCancel: () => void;
}

/** 引脚草稿行（编辑态；id 允许暂空，保存时校验） */
interface PinDraft {
  id: string;
  dir: 'in' | 'out';
  type: string;
  label: string;
}

function pinsToDrafts(pins: readonly IRSnippetPin[] | undefined): PinDraft[] {
  return (pins ?? []).map((p) => ({
    id: p.id,
    dir: p.dir,
    type: p.type,
    label: p.label ?? '',
  }));
}

function draftsToPins(drafts: readonly PinDraft[]): IRSnippetPin[] {
  const pins: IRSnippetPin[] = [];
  for (const d of drafts) {
    const pin: IRSnippetPin = { id: d.id.trim(), dir: d.dir, type: d.type.trim() || 'any' };
    if (d.label.trim() !== '') pin.label = d.label.trim();
    pins.push(pin);
  }
  return pins;
}

/** 片段编辑模态（覆盖层 + 源码 textarea + 引脚表 + 保存/取消） */
export function SnippetEditModal({ snippet, title, onSave, onCancel }: SnippetEditModalProps) {
  const [codeDraft, setCodeDraft] = useState(snippet?.code ?? '');
  const [pinDrafts, setPinDrafts] = useState<PinDraft[]>(() => pinsToDrafts(snippet?.pins));
  const [error, setError] = useState<string | null>(null);

  const updateRow = (index: number, patch: Partial<PinDraft>): void => {
    setPinDrafts((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  const removeRow = (index: number): void => {
    setPinDrafts((prev) => prev.filter((_, i) => i !== index));
  };
  const addRow = (dir: 'in' | 'out'): void => {
    setPinDrafts((prev) => [...prev, { id: '', dir, type: 'any', label: '' }]);
  };

  const save = (): void => {
    const pins = draftsToPins(pinDrafts);
    // 校验：引脚 id 非空 + 同方向唯一（跨方向同 id 允许：x = x + 1 语义，ADR-007 §1）
    const seen = new Set<string>();
    for (const p of pins) {
      if (p.id === '') {
        setError('引脚 id 不能为空（留空的引脚行将被丢弃，或补全 id 后保存）');
        return;
      }
      const key = `${p.dir}\u0000${p.id}`;
      if (seen.has(key)) {
        setError(`同方向存在重复引脚 id「${p.id}」（${p.dir === 'in' ? '输入' : '输出'}脚）`);
        return;
      }
      seen.add(key);
    }
    setError(null);
    onSave(codeDraft, pins);
  };

  const onOverlayKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onCancel();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
  };

  return (
    <div
      className="bps-snippet-modal"
      role="dialog"
      aria-label={title}
      onKeyDown={onOverlayKeyDown}
    >
      <div className="bps-snippet-modal-box">
        <div className="bps-snippet-modal-head">
          <span className="bps-snippet-modal-title">{title}</span>
          <button type="button" className="bps-snippet-modal-close" onClick={onCancel} aria-label="关闭">
            ×
          </button>
        </div>
        <textarea
          className="bps-snippet-modal-code"
          data-testid="snippet-code"
          spellCheck={false}
          value={codeDraft}
          onChange={(e) => setCodeDraft(e.target.value)}
          placeholder="片段源码（原生 TS；外部数据经输入引脚注入，出值以裸名赋值或 return 返回）"
          rows={10}
        />
        <div className="bps-snippet-modal-pins">
          <div className="bps-snippet-modal-pins-head">
            <span>引脚声明</span>
            <span>
              <button type="button" onClick={() => addRow('in')} data-testid="snippet-add-in">
                ＋输入脚
              </button>
              <button type="button" onClick={() => addRow('out')} data-testid="snippet-add-out">
                ＋输出脚
              </button>
            </span>
          </div>
          {pinDrafts.map((row, i) => (
            <div className="bps-snippet-modal-pin-row" key={i}>
              <input
                type="text"
                aria-label="引脚 id"
                placeholder="id"
                value={row.id}
                onChange={(e) => updateRow(i, { id: e.target.value })}
              />
              <select
                aria-label="方向"
                value={row.dir}
                onChange={(e) => updateRow(i, { dir: e.target.value === 'out' ? 'out' : 'in' })}
              >
                <option value="in">输入</option>
                <option value="out">输出</option>
              </select>
              <input
                type="text"
                aria-label="类型"
                placeholder="类型"
                list="bps-snippet-pin-types"
                value={row.type}
                onChange={(e) => updateRow(i, { type: e.target.value })}
              />
              <input
                type="text"
                aria-label="显示名"
                placeholder="显示名（可选）"
                value={row.label}
                onChange={(e) => updateRow(i, { label: e.target.value })}
              />
              <button type="button" aria-label="删除引脚" onClick={() => removeRow(i)}>
                删
              </button>
            </div>
          ))}
          <datalist id="bps-snippet-pin-types">
            {PIN_TYPE_OPTIONS.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
        {error ? <div className="bps-snippet-modal-error">{error}</div> : null}
        <div className="bps-snippet-modal-foot">
          <button type="button" className="bps-snippet-modal-primary" onClick={save} data-testid="snippet-save">
            保存
          </button>
          <button type="button" onClick={onCancel} data-testid="snippet-cancel">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * 命令栈接线（模块级；面板 onSave 回调使用；node:test 可直接驱动）
 * ============================================================ */

/**
 * 保存片段编辑（入 blueprint 命令栈，可撤销；见文件头保存语义）。
 * 返回 false = 域未注册 / 节点不存在 / 无变化。
 */
export function saveSnippetEdit(
  graphName: string,
  nodeId: string,
  code: string,
  pins: IRSnippetPin[],
): boolean {
  if (!isDomainRegistered('blueprint')) return false;
  const asset = getDomainState<BlueprintDomainLike>('blueprint').asset;
  const node = asset.graphs[graphName]?.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== SNIPPET_NODE_TYPE) return false;
  const existingId = node.params?.[SNIPPET_PARAM_KEY];
  const isNew = typeof existingId !== 'string' || existingId === '';
  const label = isNew ? '新建脚本片段' : '编辑脚本片段';
  const result = runCommand<BlueprintDomainLike>('blueprint', label, (draft) => {
    const g = draft.asset.graphs[graphName];
    const target = g?.nodes.find((n) => n.id === nodeId);
    if (!target) return;
    if (isNew) {
      const id = uniqueSnippetId((draft.asset.snippets ?? []).map((s) => s.id));
      draft.asset.snippets.push({ id, lang: 'ts', code, pins: [...pins] });
      target.params[SNIPPET_PARAM_KEY] = id;
      return;
    }
    const snip = (draft.asset.snippets ?? []).find(
      (s: Draft<IRSnippet>) => s.id === existingId,
    );
    if (!snip) return;
    snip.code = code;
    snip.pins = [...pins];
  });
  if (!result.changed) return false;
  // 域状态 → store 镜像刷新（等价 store.commit 的收尾；撤销 / 重做经 subscribeReplay 自动刷新）
  useBlueprintStore.getState().refreshFromDomain();
  return true;
}
