/**
 * Blueprint Studio v2 —— 蓝图检视器 Details（T2.4，PLAN §8.4）
 *
 * 蓝图编辑器右栏：
 *  - 选中 1 节点：标题 + 分类徽标 + doc 说明 + 参数编辑（ParamSpec 驱动，分组折叠）
 *    + 未连线数据输入引脚的默认值编辑（已连线 → 「已连线」置灰）；
 *  - 选中多节点：共同参数批量编辑（都声明才显示；值相同显示值，否则混合态「—」，
 *    修改统一应用到全部，单命令可一次撤销）；
 *  - 无选中：当前图设置 —— 主图显示资产名 / 入口说明；函数图显示入参 / 返回值
 *    接口编辑（IRGraph.params / returns；入口 / 出口节点的数据脚由声明动态决定，
 *    视图动态引脚待 view 层后续支持，本期已汇报）。
 *
 * 资产修改全部经 useBlueprintStore 的 action（内部入命令栈，可撤销）。
 * 本组件不 import 样式（node:test 可挂载冒烟）：details.css 由 BlueprintEditorPanel 引入。
 */
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { Icon } from '../../shell/ui/Icon';
import type { IRAsset, IRGraph, IRNode, IRParamSpec, IRValueType, NodeSpec } from '../../ir/types';
import { useBlueprintStore } from '../store/blueprint-store';
import { VARIABLE_TYPES } from '../my-blueprint/model';
import { commonParamRows, connectedInputPins, groupParams } from './details-model';
import { ParamFieldRow, PinDefaultRow } from './param-editors';

/* ============================================================
 * 分组折叠（UE Details 分组观感）
 * ============================================================ */

function CollapsibleGroup(props: { title: string; badge?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bp-det-group">
      <button type="button" className="bp-det-group-head" onClick={() => setOpen(!open)}>
        <span className="bp-det-caret" aria-hidden>
          <Icon icon={open ? ChevronDown : ChevronRight} size={12} />
        </span>
        <span className="bp-det-group-title">{props.title}</span>
        {props.badge ? <span className="bp-det-count">{props.badge}</span> : null}
      </button>
      {open ? <div className="bp-det-group-body">{props.children}</div> : null}
    </div>
  );
}

/* ============================================================
 * 图接口行编辑（函数入参 / 返回值；Details 无选中时）
 * ============================================================ */

/** 单行：参数名（失焦提交）+ 类型下拉（即改即提交）+ 删除 */
function InterfaceRow(props: {
  row: IRParamSpec;
  onName: (name: string) => void;
  onType: (type: IRValueType) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(props.row.name);
  const committedRef = useRef(props.row.name);
  // 外部值变化（撤销 / 切图）→ 同步回编辑框
  useEffect(() => {
    if (committedRef.current === props.row.name) return;
    committedRef.current = props.row.name;
    setDraft(props.row.name);
  }, [props.row.name]);
  const commit = (): void => {
    if (draft === props.row.name) return;
    committedRef.current = draft;
    props.onName(draft);
  };
  return (
    <div className="bp-det-row bp-det-row--iface">
      <input
        className="bp-det-input"
        value={draft}
        placeholder="参数名"
        aria-label="参数名"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
        onBlur={commit}
      />
      <select
        className="bp-det-select"
        value={props.row.type}
        aria-label="参数类型"
        onChange={(e) => props.onType(e.target.value as IRValueType)}
      >
        {VARIABLE_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <button type="button" className="bp-det-btn" title="删除该行" onClick={props.onRemove}>
        <Icon icon={X} size={12} />
      </button>
    </div>
  );
}

/** 接口行组：增删行 / 改名改类型；整组经 onChange 提交（一次一条命令） */
function InterfaceRows(props: {
  rows: IRParamSpec[];
  addText: string;
  onChange: (rows: IRParamSpec[]) => void;
}) {
  return (
    <>
      {props.rows.map((row, i) => (
        <InterfaceRow
          key={i}
          row={row}
          onName={(name) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, name } : r)))}
          onType={(type) => props.onChange(props.rows.map((r, j) => (j === i ? { ...r, type } : r)))}
          onRemove={() => props.onChange(props.rows.filter((_, j) => j !== i))}
        />
      ))}
      <button
        type="button"
        className="bp-det-btn bp-det-btn--wide"
        onClick={() => props.onChange([...props.rows, { name: '', type: 'any' }])}
      >
        <Icon icon={Plus} size={12} /> {props.addText}
      </button>
    </>
  );
}

/* ============================================================
 * 无选中：当前图设置
 * ============================================================ */

function GraphSettingsSection(props: {
  asset: IRAsset;
  graph: IRGraph;
  graphName: string;
  isEntry: boolean;
}) {
  const { asset, graph, graphName, isEntry } = props;
  if (isEntry) {
    return (
      <>
        <div className="bp-det-title">{asset.name}</div>
        <div className="bp-det-sub">
          <span className="bp-det-badge">主图</span>
          <span className="bp-det-id">{graphName}</span>
        </div>
        <p className="bp-det-hint">
          主图是资产的事件入口：绑定 UI 节点后，UI 事件与「开始」节点从这里触发。选中画布节点可在此编辑其参数与引脚默认值。
        </p>
        <div className="bp-det-kv">
          <span>节点</span>
          <span>{graph.nodes.length}</span>
        </div>
        <div className="bp-det-kv">
          <span>连线</span>
          <span>{graph.edges.length}</span>
        </div>
      </>
    );
  }
  const paramRows = graph.params ?? [];
  const returnRows = graph.returns ?? [];
  return (
    <>
      <div className="bp-det-title">{graphName}</div>
      <div className="bp-det-sub">
        <span className="bp-det-badge">函数</span>
        <span className="bp-det-id">{graphName}</span>
      </div>
      <p className="bp-det-hint">
        函数接口：入参 / 返回值在此声明；运行时入口 / 出口节点的数据脚按声明动态注入。动态引脚在画布上的渲染待后续支持，期间可在图内经变量中转。
      </p>
      <CollapsibleGroup title="入参" badge={`${paramRows.length}`}>
        <InterfaceRows
          rows={paramRows}
          addText="入参"
          onChange={(rows) => useBlueprintStore.getState().setGraphParams(graphName, rows)}
        />
      </CollapsibleGroup>
      <CollapsibleGroup title="返回值" badge={`${returnRows.length}`}>
        <InterfaceRows
          rows={returnRows}
          addText="返回值"
          onChange={(rows) => useBlueprintStore.getState().setGraphReturns(graphName, rows)}
        />
      </CollapsibleGroup>
      <p className="bp-det-hint">调用方式：在 My Blueprint 的函数列表右键「插入调用到当前图」。</p>
    </>
  );
}

/* ============================================================
 * 选中 1 节点
 * ============================================================ */

function SingleNodeSection(props: { node: IRNode; spec: NodeSpec | null; graph: IRGraph | null }) {
  const { node, spec, graph } = props;
  const title = node.title ?? spec?.title ?? node.type;
  const params = spec?.params ?? [];
  const paramGroups = groupParams(params);
  const hasGroups = params.some((p) => p.group);
  const dataInputs = (spec?.inputs ?? []).filter((p) => p.type !== 'exec');
  const connected = connectedInputPins(graph, node.id);
  const unknownParams = spec ? [] : Object.entries(node.params ?? {});

  return (
    <>
      <div className="bp-det-title">{title}</div>
      <div className="bp-det-sub">
        {spec?.category ? (
          <span className="bp-det-badge">{spec.category}</span>
        ) : (
          <span className="bp-det-badge bp-det-badge--unknown">未知节点</span>
        )}
        <span className="bp-det-id">{node.type}</span>
      </div>
      <p className="bp-det-doc">
        {spec?.doc ?? '节点库中不存在该类型：可能是插件未启用或节点已删除。'}
      </p>
      {node.comment ? <p className="bp-det-comment">{node.comment}</p> : null}

      {params.length > 0 ? (
        <CollapsibleGroup title="参数" badge={`${params.length}`}>
          {hasGroups
            ? paramGroups.map((group) => (
                <div key={group.group} className="bp-det-subgroup">
                  <div className="bp-det-subgroup-title">{group.group}</div>
                  {group.params.map((param) => (
                    <ParamFieldRow
                      key={param.id}
                      param={param}
                      value={node.params?.[param.id] !== undefined ? node.params[param.id] : param.default}
                      onCommit={(value) =>
                        useBlueprintStore.getState().setNodeParams(node.id, { [param.id]: value })
                      }
                    />
                  ))}
                </div>
              ))
            : params.map((param) => (
                <ParamFieldRow
                  key={param.id}
                  param={param}
                  value={node.params?.[param.id] !== undefined ? node.params[param.id] : param.default}
                  onCommit={(value) =>
                    useBlueprintStore.getState().setNodeParams(node.id, { [param.id]: value })
                  }
                />
              ))}
        </CollapsibleGroup>
      ) : null}

      {dataInputs.length > 0 ? (
        <CollapsibleGroup title="引脚默认值" badge={`${dataInputs.length}`}>
          {dataInputs.map((pin) => (
            <PinDefaultRow
              key={pin.id}
              pin={pin}
              written={node.pinDefaults?.[pin.id]}
              connected={connected.has(pin.id)}
              onCommit={(value) => useBlueprintStore.getState().setPinDefault(node.id, pin.id, value)}
            />
          ))}
        </CollapsibleGroup>
      ) : null}

      {unknownParams.length > 0 ? (
        <CollapsibleGroup title="参数（只读）" badge={`${unknownParams.length}`}>
          {unknownParams.map(([key, value]) => (
            <div key={key} className="bp-det-row">
              <span className="bp-det-label">{key}</span>
              <div className="bp-det-control">
                <span className="bp-det-readonly">{String(value)}</span>
              </div>
            </div>
          ))}
        </CollapsibleGroup>
      ) : null}

      {params.length === 0 && dataInputs.length === 0 && unknownParams.length === 0 ? (
        <div className="bp-det-empty">该节点没有可编辑参数或引脚默认值</div>
      ) : null}
    </>
  );
}

/* ============================================================
 * 选中多节点：共同参数批量编辑
 * ============================================================ */

function MultiNodeSection(props: {
  nodes: IRNode[];
  specs: ReadonlyMap<string, NodeSpec>;
}) {
  const { nodes, specs } = props;
  const rows = commonParamRows(specs, nodes);
  const nodeIds = nodes.map((n) => n.id);
  return (
    <>
      <div className="bp-det-title">已选 {nodes.length} 个节点</div>
      <p className="bp-det-hint">
        仅列出全部选中节点共有的参数；值不同的显示为「—」（混合），修改会统一应用到全部选中节点。
      </p>
      {rows.length > 0 ? (
        <CollapsibleGroup title="共同参数" badge={`${rows.length}`}>
          {rows.map((row) => (
            <ParamFieldRow
              key={row.param.id}
              param={row.param}
              value={row.value}
              mixed={row.mixed}
              onCommit={(value) =>
                useBlueprintStore.getState().setNodesParams(nodeIds, { [row.param.id]: value })
              }
            />
          ))}
        </CollapsibleGroup>
      ) : (
        <div className="bp-det-empty">选中节点没有共同参数</div>
      )}
    </>
  );
}

/* ============================================================
 * 面板本体
 * ============================================================ */

export function Details({ className }: { className?: string }) {
  const asset = useBlueprintStore((s) => s.asset);
  const specs = useBlueprintStore((s) => s.specs);
  const graphName = useBlueprintStore((s) => s.graphName);
  const selection = useBlueprintStore((s) => s.selection);

  if (!asset) return null;
  const graph = asset.graphs[graphName] ?? null;
  const selectedNodes = selection.nodeIds
    .map((id) => graph?.nodes.find((n) => n.id === id) ?? null)
    .filter((n): n is IRNode => n !== null);

  return (
    <div className={`bp-det${className ? ` ${className}` : ''}`}>
      <div className="bp-det-header">Details</div>
      <div className="bp-det-body">
        {selectedNodes.length === 0 ? (
          graph ? (
            <GraphSettingsSection
              asset={asset}
              graph={graph}
              graphName={graphName}
              isEntry={graphName === asset.entry && graph.kind !== 'function'}
            />
          ) : (
            <div className="bp-det-empty">未打开图</div>
          )
        ) : selectedNodes.length === 1 ? (
          <SingleNodeSection
            node={selectedNodes[0]!}
            spec={specs.get(selectedNodes[0]!.type) ?? null}
            graph={graph}
          />
        ) : (
          <MultiNodeSection nodes={selectedNodes} specs={specs} />
        )}
      </div>
    </div>
  );
}
