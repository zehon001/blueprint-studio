/**
 * Blueprint Studio v2 —— 蓝图节点渲染器（T2.1，PLAN §8.1 节点视觉复刻）
 *
 * 完全自定义 nodeTypes（单类型 'bpNode'，视觉差异由 data.variant 分支）：
 * - 头：分类配色（事件红/函数蓝/纯函数绿/流程灰/插件紫）+ 图标 + 标题/副标题；
 * - var Get/Set（id 前缀 'var.'）：无头紧凑样式（--node-var-bg/var-border），「Get 变量名」单行；
 * - 引脚行：输入在左、输出在右；Handle 颜色按 pinColor(pin.type)，exec 为白色三角（clip-path）；
 * - 数据输入引脚未连线时渲染内联默认值编辑框（可编辑 state；接 IR 命令栈属 T2.2/T2.4）；
 * - 未知节点：灰色 + 警示图标降级样式（引脚从连线还原，保证连线仍可锚定）。
 * 取色一律经 tokens.ts / model.ts 的映射函数，本文件无硬编码色值。
 */
import { memo, useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { FunctionSquare, GitBranch, Puzzle, Sigma, TriangleAlert, Zap, type LucideIcon } from 'lucide-react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { IRNode, NodeSpec, PinSpec, UINode } from '../../ir/types';
import { Icon } from '../../shell/ui/Icon';
import { PIN_COLORS, pinColor } from '../../shell/theme/tokens';
import type { DebugHighlightKind } from '../../shell/debug/overlay-state';
import { useSceneTreeDomain } from '../../ui-editor/store';
import { uiTraitsForType } from '../../ui-editor/schema';
import { getCachedElement } from '../../ui-editor/element';
import { getCachedPrefab } from '../../ui-editor/prefab';
import {
  headColorFor,
  headIconFor,
  nodeSubtitle,
  varDisplayName,
  varOpOf,
  type BPNodeData,
  type FlowNode,
} from './model';

/** 叠加层数据形态（T5.4 debugHighlight 由 src/shell/debug 注入；type-only，不依赖运行时） */
type BPNodeDataWithDebug = BPNodeData & { debugHighlight?: DebugHighlightKind };

/** 节点运行时叠加 class（data.debugHighlight → 描边脉冲 / 错误红晕，样式见 debug.css） */
function debugClassOf(data: BPNodeData): string {
  const kind = (data as BPNodeDataWithDebug).debugHighlight;
  if (kind === 'error') return ' bp-node--debug-error';
  if (kind === 'active') return ' bp-node--debug-active';
  return '';
}

/** CSS 自定义属性内联样式（React 类型不含任意 --var，集中收口） */
function cssVars(vars: Record<string, string>): CSSProperties {
  return vars as CSSProperties;
}

/** 节点头图标（Lucide；替代 headIconFor 的 Unicode 字形） */
function headIconOf(variant: Parameters<typeof headIconFor>[0]): LucideIcon {
  switch (variant) {
    case 'event':
      return Zap;
    case 'function':
      return FunctionSquare;
    case 'pure':
      return Sigma;
    case 'flow':
      return GitBranch;
    case 'plugin':
      return Puzzle;
    default:
      return TriangleAlert;
  }
}

/* ============================================================
 * 内联默认值编辑器（未连线数据输入引脚）
 * ============================================================ */

/** 默认值编辑器种类（T2.4 检视器可复用） */
export function editorKindOf(pin: PinSpec): 'bool' | 'number' | 'select' | 'text' | null {
  if (pin.type === 'exec') return null;
  if (pin.type === 'bool') return 'bool';
  if (pin.type === 'int' || pin.type === 'float') return 'number';
  if (pin.type === 'string') {
    return pin.options && pin.options.length > 0 ? 'select' : 'text';
  }
  // object / any / 数组 / 自定义类型：不提供内联编辑框
  return null;
}

interface EditorProps {
  pin: PinSpec;
  value: unknown;
  onCommit: (value: unknown) => void;
}

/** 未连线时显示的初始值（pinDefaults 优先，回落 PinSpec.defaultValue） */
function initialValueOf(pin: PinSpec, value: unknown): unknown {
  return value === undefined ? pin.defaultValue : value;
}

function BoolDefaultEditor({ pin, value, onCommit }: EditorProps) {
  const initial = initialValueOf(pin, value);
  const checked = typeof initial === 'boolean' ? initial : Boolean(initial ?? false);
  return (
    <input
      type="checkbox"
      className="bp-pin-default bp-pin-default--bool"
      checked={checked}
      title={String(checked)}
      onChange={(e) => onCommit(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function NumberDefaultEditor({ pin, value, onCommit }: EditorProps) {
  const initial = String(initialValueOf(pin, value) ?? '');
  const [draft, setDraft] = useState(initial);
  // IR 侧值变化（撤销 / 检视器修改）时同步回编辑框
  useEffect(() => setDraft(String(initialValueOf(pin, value) ?? '')), [initial, pin, value]);
  const isInt = pin.type === 'int';
  return (
    <input
      type="number"
      step={isInt ? 1 : 'any'}
      className="bp-pin-default bp-pin-default--num"
      value={draft}
      onChange={(e) => {
        const rawText = e.target.value;
        setDraft(rawText);
        if (rawText.trim() === '') {
          onCommit(isInt ? 0 : 0);
          return;
        }
        const parsed = Number(rawText);
        if (Number.isFinite(parsed)) onCommit(isInt ? Math.trunc(parsed) : parsed);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function SelectDefaultEditor({ pin, value, onCommit }: EditorProps) {
  const initial = String(initialValueOf(pin, value) ?? '');
  return (
    <select
      className="bp-pin-default bp-pin-default--select"
      value={initial}
      onChange={(e) => onCommit(e.target.value)}
      onClick={(e) => e.stopPropagation()}
    >
      {(pin.options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/** 这些 UI 访问器节点的 `name` 引脚可用图属主树节点名下拉（v3 子节点选择器） */
const UI_NAME_PIN_TYPES = new Set([
  'ui.get',
  'ui.getValue',
  'ui.setText',
  'ui.setValue',
  'ui.setVisible',
  'ui.listSetItems',
  'ui.setTitle',
])

/** UI 访问器需要的 trait（无 = 不过滤） */
const ACCESSOR_TRAIT: Readonly<Record<string, string>> = {
  'ui.setText': 'text',
  'ui.setTitle': 'text',
  'ui.setValue': 'value',
  'ui.listSetItems': 'items',
}

function traitsOfUiNode(n: UINode): string[] {
  if (n.element) return [...(getCachedElement(n.element)?.traits ?? [])]
  if (n.prefab) {
    const root = getCachedPrefab(n.prefab)?.root
    return root ? uiTraitsForType(root.type) : []
  }
  return uiTraitsForType(n.type)
}

function UiNodeNameDefaultEditor({
  pin,
  value,
  onCommit,
  accessorType,
}: EditorProps & { accessorType: string }) {
  const { asset } = useSceneTreeDomain()
  const required = ACCESSOR_TRAIT[accessorType]
  const names: string[] = []
  const walk = (n: UINode): void => {
    if (!required || traitsOfUiNode(n).includes(required)) names.push(n.name)
    for (const c of n.children ?? []) walk(c)
  }
  if (asset) walk(asset.root)
  const initial = String(initialValueOf(pin, value) ?? '')
  // 树为空（独立 .bp.json / 嵌入前）退回文本输入，保证仍可手填
  if (names.length === 0) return <TextDefaultEditor pin={pin} value={value} onCommit={onCommit} />
  const options = initial && !names.includes(initial) ? [initial, ...names] : names
  return (
    <select
      className="bp-pin-default bp-pin-default--select"
      value={initial}
      onChange={(e) => onCommit(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="选择 UI 节点"
    >
      <option value="">（选择节点）</option>
      {options.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  )
}

function TextDefaultEditor({ pin, value, onCommit }: EditorProps) {
  const initial = String(initialValueOf(pin, value) ?? '');
  const [draft, setDraft] = useState(initial);
  useEffect(() => setDraft(String(initialValueOf(pin, value) ?? '')), [initial, pin, value]);
  return (
    <input
      type="text"
      className="bp-pin-default bp-pin-default--text"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        onCommit(e.target.value);
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/** 引脚内联默认值编辑框（按类型分发；空值编辑不落 IR，TODO 见 onCommit） */
function PinDefaultEditor({ nodeId, pin, data }: { nodeId: string; pin: PinSpec; data: BPNodeData }) {
  const rawValue = data.node.pinDefaults?.[pin.id];
  const value = initialValueOf(pin, rawValue);
  const onCommit = (next: unknown) => {
    // TODO(T2.2/T2.4)：经统一命令栈写入 IRNode.pinDefaults（可撤销）；本卡仅透传可选回调 + 本地 state
    data.onPinDefaultChange?.(nodeId, pin.id, next);
  };
  if (pin.id === 'name' && UI_NAME_PIN_TYPES.has(data.node.type)) {
    return (
      <UiNodeNameDefaultEditor
        pin={pin}
        value={value}
        onCommit={onCommit}
        accessorType={data.node.type}
      />
    );
  }
  switch (editorKindOf(pin)) {
    case 'bool': return <BoolDefaultEditor pin={pin} value={value} onCommit={onCommit} />;
    case 'number': return <NumberDefaultEditor pin={pin} value={value} onCommit={onCommit} />;
    case 'select': return <SelectDefaultEditor pin={pin} value={value} onCommit={onCommit} />;
    case 'text': return <TextDefaultEditor pin={pin} value={value} onCommit={onCommit} />;
    default: return null;
  }
}

/* ============================================================
 * 引脚行（Handle + 标签 + 可选内联默认值）
 * ============================================================ */

function pinHandle(pin: PinSpec, dir: 'in' | 'out', key?: string) {
  const isExec = pin.type === 'exec';
  return (
    <Handle
      key={key ?? pin.id}
      type={dir === 'in' ? 'target' : 'source'}
      position={dir === 'in' ? Position.Left : Position.Right}
      id={pin.id}
      className={`bp-handle bp-handle--${dir} ${isExec ? 'bp-handle-exec' : 'bp-handle-data'}`}
      style={isExec ? undefined : cssVars({ '--pin-color': pinColor(pin.type) })}
    />
  );
}

function PinRow({ nodeId, pin, dir, data }: { nodeId: string; pin: PinSpec; dir: 'in' | 'out'; data: BPNodeData }) {
  const isExec = pin.type === 'exec';
  const label = pin.label ?? pin.id;
  const editor =
    dir === 'in' && !isExec && !data.connectedInputs.has(pin.id) ? (
      <PinDefaultEditor nodeId={nodeId} pin={pin} data={data} />
    ) : null;
  return (
    <div className={`bp-pin-row bp-pin-row--${dir}`}>
      {dir === 'in' ? (
        <>
          {pinHandle(pin, dir)}
          <span className="bp-pin-label" title={pin.type}>
            {label}
          </span>
          {editor}
        </>
      ) : (
        <>
          <span className="bp-pin-label" title={pin.type}>
            {label}
          </span>
          {pinHandle(pin, dir)}
        </>
      )}
    </div>
  );
}

/** 未知节点的降级引脚行（类型未知按 any 灰圈渲染，保证连线可锚定） */
function DegradedPinRow({ pinId, dir }: { pinId: string; dir: 'in' | 'out' }) {
  return (
    <div className={`bp-pin-row bp-pin-row--${dir}`}>
      {dir === 'in' ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id={pinId}
            className="bp-handle bp-handle--in bp-handle-data bp-handle--degraded"
            style={cssVars({ '--pin-color': PIN_COLORS.any })}
          />
          <span className="bp-pin-label">{pinId}</span>
        </>
      ) : (
        <>
          <span className="bp-pin-label">{pinId}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={pinId}
            className="bp-handle bp-handle--out bp-handle-data bp-handle--degraded"
            style={cssVars({ '--pin-color': PIN_COLORS.any })}
          />
        </>
      )}
    </div>
  );
}

/* ============================================================
 * 节点体部件
 * ============================================================ */

/** 参数值显示文本（undefined 回落 ParamSpec.default） */
function paramValueText(value: unknown, fallback: unknown): string {
  const v = value === undefined ? fallback : value;
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}

/** 参数行（本期只读展示；编辑属 T2.4 检视器） */
function NodeParamsBlock({ node, spec }: { node: IRNode; spec: NodeSpec }) {
  const params = spec.params ?? [];
  if (params.length === 0) return null;
  return (
    <div className="bp-node-params">
      {params.map((p) => (
        <div key={p.id} className="bp-node-param">
          <span className="bp-node-param-label">{p.label}</span>
          <span className="bp-node-param-value">{paramValueText(node.params?.[p.id], p.default)}</span>
        </div>
      ))}
    </div>
  );
}

/** 合并静态引脚与函数签名动态引脚（同 id 以静态为准） */
function mergePins(base: readonly PinSpec[], extra: readonly PinSpec[] | undefined): PinSpec[] {
  if (!extra || extra.length === 0) return [...base];
  const seen = new Set(base.map((p) => p.id));
  return [...base, ...extra.filter((p) => !seen.has(p.id))];
}

/** 常规节点：头 + 注释 + 参数行 + 引脚两列（输入左 / 输出右） */
function RegularNodeView({ nodeId, data, selected }: { nodeId: string; data: BPNodeData; selected: boolean }) {
  const { node, spec, variant } = data;
  if (!spec) return null;
  const title = node.title ?? spec.title;
  const subtitle = nodeSubtitle(spec, data.graphName);
  const inputPins = mergePins(spec.inputs, data.dynamicPins?.inputs);
  const outputPins = mergePins(spec.outputs, data.dynamicPins?.outputs);
  return (
    <div
      className={`bp-node bp-variant-${variant}${selected ? ' bp-node--selected' : ''}${debugClassOf(data)}`}
      style={cssVars({ '--bp-head-color': headColorFor(variant) })}
    >
      <div className="bp-node-head" style={{ background: headColorFor(variant) }}>
        <span className="bp-node-icon" aria-hidden="true">
          <Icon icon={headIconOf(variant)} size={12} />
        </span>
        <span className="bp-node-titles">
          <span className="bp-node-title">{title}</span>
          <span className="bp-node-subtitle">{subtitle}</span>
        </span>
      </div>
      {node.comment ? <div className="bp-node-comment">{node.comment}</div> : null}
      <NodeParamsBlock node={node} spec={spec} />
      <div className="bp-node-pins">
        <div className="bp-pin-col bp-pin-col--in">
          {inputPins.map((pin) => (
            <PinRow key={pin.id} nodeId={nodeId} pin={pin} dir="in" data={data} />
          ))}
        </div>
        <div className="bp-pin-col bp-pin-col--out">
          {outputPins.map((pin) => (
            <PinRow key={pin.id} nodeId={nodeId} pin={pin} dir="out" data={data} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** 变量 Get/Set：无头紧凑样式（--node-var-bg/var-border），左缘色条按变量类型引脚色 */
function VarNodeView({ data, selected }: { data: BPNodeData; selected: boolean }) {
  const { node, spec } = data;
  const op = varOpOf(node.type) ?? 'get';
  const name = varDisplayName(node);
  const inPins = spec?.inputs ?? [];
  const outPins = spec?.outputs ?? [];
  const execInPin = inPins.find((p) => p.type === 'exec');
  const execOutPin = outPins.find((p) => p.type === 'exec');
  const dataInPin = inPins.find((p) => p.type !== 'exec');
  const dataOutPin = outPins.find((p) => p.type !== 'exec');
  const typeColor = pinColor((op === 'get' ? dataOutPin?.type : dataInPin?.type) ?? 'any');
  const rootClass = `bp-node bp-node-var${selected ? ' bp-node--selected' : ''}${debugClassOf(data)}`;
  const titleEl = (
    <span className="bp-var-title">
      {op === 'set' ? 'Set ' : 'Get '}
      {name}
    </span>
  );
  if (op === 'set') {
    return (
      <div className={rootClass} style={cssVars({ '--var-color': typeColor })}>
        <div className="bp-pin-row bp-pin-row--var">
          {execInPin ? pinHandle(execInPin, 'in') : null}
          {titleEl}
          {execOutPin ? pinHandle(execOutPin, 'out') : null}
        </div>
        {dataInPin ? (
          <div className="bp-pin-row bp-pin-row--var">
            {pinHandle(dataInPin, 'in')}
            <span className="bp-pin-label">{dataInPin.label ?? dataInPin.id}</span>
            {dataOutPin ? pinHandle(dataOutPin, 'out') : null}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div className={rootClass} style={cssVars({ '--var-color': typeColor })}>
      <div className="bp-pin-row bp-pin-row--var bp-pin-row--get">
        {titleEl}
        {dataOutPin ? pinHandle(dataOutPin, 'out') : null}
      </div>
    </div>
  );
}

/** 未知节点：灰色头 + 警示图标 + 从连线还原的降级引脚 */
function UnknownNodeView({ data, selected }: { data: BPNodeData; selected: boolean }) {
  const { node, variant } = data;
  return (
    <div
      className={`bp-node bp-variant-unknown${selected ? ' bp-node--selected' : ''}${debugClassOf(data)}`}
      style={cssVars({ '--bp-head-color': headColorFor(variant) })}
    >
      <div className="bp-node-head" style={{ background: headColorFor(variant) }}>
        <span className="bp-node-icon" aria-hidden="true">
          <Icon icon={headIconOf(variant)} size={12} />
        </span>
        <span className="bp-node-titles">
          <span className="bp-node-title">{node.title ?? node.type}</span>
          <span className="bp-node-subtitle">未知节点类型</span>
        </span>
      </div>
      <div className="bp-node-pins">
        <div className="bp-pin-col bp-pin-col--in">
          {data.degradedInputs.map((pinId) => (
            <DegradedPinRow key={pinId} pinId={pinId} dir="in" />
          ))}
        </div>
        <div className="bp-pin-col bp-pin-col--out">
          {data.degradedOutputs.map((pinId) => (
            <DegradedPinRow key={pinId} pinId={pinId} dir="out" />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * 注册入口（nodeTypes['bpNode']）
 * ============================================================ */

function BPNodeInner({ id, data, selected }: NodeProps<FlowNode>) {
  if (data.variant === 'var') return <VarNodeView data={data} selected={Boolean(selected)} />;
  if (data.variant === 'unknown' || !data.spec) {
    return <UnknownNodeView data={data} selected={Boolean(selected)} />;
  }
  return <RegularNodeView nodeId={id} data={data} selected={Boolean(selected)} />;
}

/** 蓝图节点组件（memo：IR 数据不变不重渲染） */
export const BPNode = memo(BPNodeInner);
