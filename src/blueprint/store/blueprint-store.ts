/**
 * Blueprint Studio v2 —— 蓝图编辑状态（T2.2 组装 / T2.3 资产级编辑扩充，PLAN §6.3 命令栈 / §8.2 交互）
 *
 * 职责划分：
 *  - **命令栈域状态**（唯一文档真源）：registerDomainState('blueprint', { asset })，
 *    全部图编辑（增删节点 / 连线 / 移动 / 参数 / 引脚默认值 / 粘贴）与
 *    T2.3 结构面板资产编辑（变量 / 函数图 / 自定义事件 / 图接口 / 批量参数）经
 *    runCommand('blueprint', label, recipe) 执行 → 入统一撤销重做栈；
 *  - **useBlueprintStore（zustand）**：域状态镜像 + 编辑器 UI 状态
 *    （当前图名 / 选中集 / 脏标记 / 最近使用 / 弹出菜单 / 校验结果 / 提示）。
 *    镜像在 commit() 与 refreshFromDomain()（undo/redo 重放后）同步。
 *
 * 约定：
 *  - 图切换（switchGraph）/ 资产打开（openAsset）不进命令栈（视图状态，非文档编辑）；
 *  - 选中集不进命令栈（UE 同款：撤销不还原选区）；
 *  - specs 默认 editorSpecMap()（内置节点库 ∪ flow.call/func.entry/func.return 编辑器
 *    补充 spec，见 my-blueprint/graph-op-specs.ts），T6.4 插件节点经 setSpecs 合并注入；
 *  - 数据输入引脚（非 multi）新线顶旧线（UE 语义）；exec 输入允许多线汇入。
 */
import { create } from 'zustand';
import type { Draft } from 'immer';
import {
  getDomainState,
  isDomainRegistered,
  registerDomainState,
  runCommand,
} from '../../shell/commands';
import type { ValidationIssue } from '../../ir/validate';
import { isExecType } from '../../ir/types';
import type {
  IRAsset,
  IREdge,
  IREndpoint,
  IRNode,
  IRParamSpec,
  IRValueType,
  IRVariable,
  NodeSpec,
  Vec2,
} from '../../ir/types';
import { editorSpecMap } from '../my-blueprint/graph-op-specs';
import { nameKey, nextCopyName } from '../my-blueprint/model';
import {
  bestTargetPin,
  buildFragment,
  checkConnection,
  collectFragment,
  compatibleSpecEntries,
  createIdAllocator,
  initialParams,
  initialPinDefaults,
  instancePrefixOf,
  instantiateFragment,
  pushRecent,
  snapPosition,
  type IRFragment,
  type PinRef,
  type SpecEntry,
} from '../interaction/logic';
import { readFragment, writeFragment } from '../interaction/clipboard';

/** 命令栈 'blueprint' 域状态（唯一文档真源） */
export interface BlueprintDomainState {
  asset: IRAsset;
}

/** 选中集（节点 + 连线） */
export interface BlueprintSelection {
  nodeIds: string[];
  edgeIds: string[];
}

export const EMPTY_SELECTION: BlueprintSelection = { nodeIds: [], edgeIds: [] };

/** 画布弹出菜单（互斥单开；screen=屏幕坐标 fixed 定位，flow=画布坐标建节点用） */
export type CanvasMenu =
  | ({ kind: 'search' } & MenuPos)
  | ({ kind: 'pin'; from: PinRef } & MenuPos)
  | ({ kind: 'edge'; edgeId: string } & MenuPos)
  | null;

interface MenuPos {
  screen: Vec2;
  flow: Vec2;
}

/** 轻提示（kind=error 时配画布抖动；at 用于 toast 自动消失与重触发） */
export interface ToastState {
  text: string;
  kind: 'info' | 'error';
  at: number;
}

/** localStorage 键：最近使用节点 spec id（上限 8，LRU） */
const RECENT_STORAGE_KEY = 'bps.blueprint.recentSpecs';

export interface BlueprintStore {
  /* ---------------- 状态 ---------------- */
  /** 域状态镜像（打开资产 / 命令执行 / undo-redo 重放后同步；null = 未打开） */
  asset: IRAsset | null;
  /** 资产路径（如 'logic/main.bp.json'；保存回调透传，本期由受控 prop 提供） */
  assetPath: string | null;
  /** 当前图名（主图或函数子图；不进命令栈） */
  graphName: string;
  /** 节点定义表（默认 builtinSpecMap；T6.4 经 setSpecs 合并插件节点） */
  specs: Map<string, NodeSpec>;
  /** 选中集（不进命令栈；撤销不还原选区） */
  selection: BlueprintSelection;
  /** 脏标记（任何命令 / undo 重放后置 true；markSaved 清除） */
  dirty: boolean;
  /** 最近使用 spec id（LRU ≤ 8；localStorage 持久化） */
  recentSpecIds: string[];
  /** 画布弹出菜单（互斥单开） */
  menu: CanvasMenu;
  /** 轻提示（自动消失由组件层驱动） */
  toast: ToastState | null;
  /** 画布抖动触发戳（连线被拒时更新；组件层据此播放 shake 动画） */
  shakeAt: number;
  /** 最近一次 Ctrl+S 校验结果（null = 尚未校验） */
  validation: ValidationIssue[] | null;

  /* ---------------- 资产 / 视图 action（不进命令栈） ---------------- */
  /** 打开资产（受控 prop 驱动；注册命令域 + 重置编辑态） */
  openAsset(asset: IRAsset, assetPath?: string): void;
  /** 切换图签（不进命令栈；清空选中） */
  switchGraph(graphName: string): void;
  /** 设置选中集（ReactFlow 选择同步 / 校验跳转 / 全选共用；不进命令栈） */
  setSelection(selection: BlueprintSelection): void;
  /** undo/redo 重放后刷新镜像（subscribeReplay 回调） */
  refreshFromDomain(): void;
  /** 合并节点定义表（T6.4 插件节点注入入口） */
  setSpecs(specs: Map<string, NodeSpec>): void;
  markSaved(): void;
  setValidation(issues: ValidationIssue[]): void;
  notify(text: string, kind?: 'info' | 'error'): void;
  dismissToast(): void;
  /** 画布抖动（连线被拒提示） */
  shake(): void;
  openMenu(menu: NonNullable<CanvasMenu>): void;
  closeMenu(): void;
  /** 记录最近使用（store + localStorage，LRU ≤ 8） */
  pushRecentSpec(specId: string): void;
  /** 启动时从 localStorage 恢复最近使用（环境不支持时静默） */
  loadRecentSpecs(): void;

  /* ---------------- 编辑 action（全部经 runCommand('blueprint')，可撤销） ---------------- */
  /** 新建节点（右键搜索 / Tab 选中即建；返回新节点 id，失败返回 null） */
  addNode(specId: string, flowPos: Vec2): string | null;
  /** 新建节点并从引脚接入（引脚拖出菜单选中即建 + 自动连线） */
  addNodeConnected(specId: string, flowPos: Vec2, from: PinRef): string | null;
  /** 建立连线（含类型预检 + 自动插转换节点 + 数据输入引脚替换旧线） */
  connect(source: { node: string; pin: string }, target: { node: string; pin: string }): boolean;
  /** 断开连线（右键连线「断开」/ 批量断开选中） */
  disconnectEdges(edgeIds: readonly string[]): void;
  /** Alt+点击引脚：断开该引脚全部连线 */
  disconnectPin(nodeId: string, pinId: string, dir: 'in' | 'out'): void;
  /** 删除选中（节点 + 其挂接连线 + 选中连线） */
  deleteSelection(): void;
  /** 移动节点（拖拽结束 / 对齐分布统一入口） */
  moveNodes(moves: ReadonlyArray<{ id: string; position: Vec2 }>): void;
  /** 引脚内联默认值（BPNode 内联编辑框 / T2.4 检视器共用） */
  setPinDefault(nodeId: string, pinId: string, value: unknown): void;
  /** 节点参数（T2.4 检视器接入；merge 语义） */
  setNodeParams(nodeId: string, params: Record<string, unknown>): void;
  /** 复制选中为新节点（Ctrl+D；Ctrl+拖拽复制传拖拽位移） */
  duplicateSelection(offset?: Vec2): number;
  /** 复制选中到剪贴板（片段格式，跨图 / 跨资产可粘）；返回复制的节点数 */
  copySelection(): Promise<number>;
  /** 粘贴剪贴板片段（新 id + 偏移 20px；跨图 / 跨资产）；返回粘贴的节点数 */
  paste(): Promise<number>;
  /** 注释框（T2.7 占位：UE 同款注释节点，含节点随注释移动） */
  addComment(position: Vec2, text?: string): void;

  /* ---------------- T2.3 My Blueprint 资产级编辑（全部入命令栈） ---------------- */
  /** 新建变量（重名拒绝，大小写不敏感）；成功返回 true */
  addVariable(input: { name: string; type: IRValueType; category?: string; exposed?: boolean; default?: unknown }): boolean;
  /** 重命名变量（级联更新全部图中 var.get / var.set 的 varName）；重名 / 空名拒绝 */
  renameVariable(oldName: string, newName: string): boolean;
  /** 删除变量（级联删除全部图中引用它的 var.get / var.set 节点及其连线） */
  removeVariable(name: string): void;
  /** 编辑变量属性（type / category / exposed / default；merge 语义） */
  updateVariable(name: string, patch: Partial<Pick<IRVariable, 'type' | 'category' | 'exposed' | 'default'>>): void;
  /** 复制变量（新名 = 名_Copy / 名_Copy2 …）；返回新变量名，失败返回 null */
  duplicateVariable(name: string): string | null;
  /** 新建函数：建子图（func.entry + func.return，无连线，空接口）；重名 / 空名拒绝 */
  addFunction(name: string): boolean;
  /** 删除函数图（主图不可删；级联删除全部图中引用它的 flow.call 节点及其连线） */
  removeGraph(name: string): boolean;
  /** 新建自定义事件（重名 / 空名拒绝） */
  addEvent(def: { name: string; params?: IRParamSpec[] }): boolean;
  /** 编辑自定义事件（改名级联更新 event.custom 的 params.eventName；params 整组替换） */
  updateEvent(name: string, patch: { name?: string; params?: IRParamSpec[] }): boolean;
  /** 插入变量 Get/Set 节点到当前图（params.varName = 变量名）；返回新节点 id */
  insertVariableNode(varName: string, op: 'get' | 'set', flowPos?: Vec2): string | null;
  /** 插入函数调用节点（flow.call，params.graph = 函数名）到当前图；返回新节点 id */
  insertFunctionCall(graphName: string, flowPos?: Vec2): string | null;
  /** 插入自定义事件入口节点（event.custom，params.eventName = 事件名）到当前图；返回新节点 id */
  insertEventNode(eventName: string, flowPos?: Vec2): string | null;

  /* ---------------- T2.3/T2.4 图接口与批量编辑（全部入命令栈） ---------------- */
  /** 设置函数图入参声明（整组替换；Details 无选中时的「图接口」区） */
  setGraphParams(graphName: string, params: IRParamSpec[]): void;
  /** 设置函数图返回值声明（整组替换） */
  setGraphReturns(graphName: string, returns: IRParamSpec[]): void;
  /** 批量设置节点参数（Details 多选共同参数；单命令可一次撤销） */
  setNodesParams(nodeIds: readonly string[], params: Record<string, unknown>): void;
}

/* ============================================================
 * 内部工具
 * ============================================================ */

/** 当前图（不存在返回 null） */
function currentGraph(asset: IRAsset | null, graphName: string) {
  return asset?.graphs[graphName] ?? null;
}

/** 深拷贝（IR 为纯 JSON 数据） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 无画布坐标时的兜底落点：按节点数错开，避免多次插入叠在同一位置 */
function staggeredPosition(nodeCount: number): Vec2 {
  const slot = nodeCount % 10;
  return { x: 60 + slot * 30, y: 60 + slot * 40 };
}

/** 读取最近使用（localStorage；不可用环境返回空） */
function readRecentStorage(): string[] {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(RECENT_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === 'string');
      }
    }
  } catch {
    // localStorage 不可用（隐私模式 / SSR）：忽略
  }
  return [];
}

function writeRecentStorage(list: readonly string[]): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
    }
  } catch {
    // 持久化失败静默（内存中的 LRU 仍然生效）
  }
}

/* ============================================================
 * store 定义
 * ============================================================ */

export const useBlueprintStore = create<BlueprintStore>()((set, get) => {
  /**
   * 命令提交 + 镜像同步：所有图编辑的统一出口。
   * recipe 直接改 draft.asset；成功后刷新镜像、置脏标记。
   */
  function commit(
    label: string,
    recipe: (asset: Draft<IRAsset>, ctx: { graphName: string }) => void,
  ): boolean {
    if (!isDomainRegistered('blueprint')) return false;
    const { graphName } = get();
    const result = runCommand<BlueprintDomainState>('blueprint', label, (draft) => {
      recipe(draft.asset, { graphName });
    });
    if (!result.changed) return false;
    set({ asset: getDomainState<BlueprintDomainState>('blueprint').asset, dirty: true });
    return true;
  }

  /** 选区 → 片段 → 实例化（新 id + 偏移；复制 / 拖拽复制共用）；无选区返回 null */
  function instantiateSelection(offset: Vec2) {
    const { asset, graphName, selection } = get();
    const graph = currentGraph(asset, graphName);
    if (!asset || !graph || selection.nodeIds.length === 0) return null;
    const picked = collectFragment(graph, new Set(selection.nodeIds));
    if (picked.nodes.length === 0) return null;
    const fragment = buildFragment(picked.nodes, picked.edges, asset.variables);
    return instantiateFragment(fragment, graph.nodes.map((n) => n.id), asset.variables, offset);
  }

  /** 落库实例化结果（节点 + 内部连线 + 缺失变量），并把选中集切到新节点 */
  function insertInstantiated(
    label: string,
    inst: { nodes: IRNode[]; edges: IREdge[]; variables: IRVariable[] },
  ): number {
    const ok = commit(label, (draft, ctx) => {
      const g = draft.graphs[ctx.graphName];
      if (!g) return;
      g.nodes.push(...inst.nodes);
      g.edges.push(...inst.edges);
      for (const v of inst.variables) draft.variables.push(v);
    });
    if (!ok) return 0;
    set({ selection: { nodeIds: inst.nodes.map((n) => n.id), edgeIds: [] } });
    return inst.nodes.length;
  }

  /** 新建节点公共体（右键搜索 / 引脚菜单共用；from 非空时自动连线） */
  function addNodeInternal(specId: string, flowPos: Vec2, from: PinRef | null): string | null {
    const state = get();
    const spec = state.specs.get(specId);
    const graph = currentGraph(state.asset, state.graphName);
    if (!spec || !graph) return null;
    // id / 连线 id 在命令前分配（确定性，避免 recipe 内产生闭包状态）
    const alloc = createIdAllocator([
      ...graph.nodes.map((n) => n.id),
      ...graph.edges.map((e) => e.id),
    ]);
    const newId = alloc.next(instancePrefixOf(specId) || 'node');
    const position = snapPosition(flowPos);

    // 预解析接入引脚（菜单建线只接可赋值引脚，自动转换走 connect 流程）
    let connection: ({ from: IREndpoint; to: IREndpoint; kind: 'exec' | 'data' }) | null = null;
    if (from) {
      const fromType: IRValueType = from.type ?? 'any';
      const fromIsExec = isExecType(fromType);
      if (from.dir === 'out') {
        const pin = bestTargetPin(spec.inputs, fromType, { targetDir: 'in' });
        if (pin) {
          connection = {
            from: { node: from.nodeId, pin: from.pinId },
            to: { node: newId, pin: pin.id },
            kind: fromIsExec ? 'exec' : 'data',
          };
        }
      } else {
        const pin = bestTargetPin(spec.outputs, fromType, { targetDir: 'out' });
        if (pin) {
          connection = {
            from: { node: newId, pin: pin.id },
            to: { node: from.nodeId, pin: from.pinId },
            kind: fromIsExec ? 'exec' : 'data',
          };
        }
      }
    }
    const edgeId = connection ? alloc.next('e') : null;

    const ok = commit(from ? '添加并连接节点' : '添加节点', (draft, ctx) => {
      const g = draft.graphs[ctx.graphName];
      if (!g) return;
      g.nodes.push({
        id: newId,
        type: specId,
        params: initialParams(spec),
        pinDefaults: initialPinDefaults(spec),
        position,
      });
      if (connection && edgeId) {
        g.edges.push({ id: edgeId, ...connection });
      }
    });
    if (!ok) return null;
    get().pushRecentSpec(specId);
    set({ selection: { nodeIds: [newId], edgeIds: [] } });
    return newId;
  }

  /**
   * My Blueprint 插入节点公共体（变量 Get/Set / 函数调用 / 事件入口共用）：
   * 单命令建节点（spec 默认值 ∪ 指定 params），落点 = 指定坐标或按节点数错开。
   */
  function insertOwnedNode(
    specId: string,
    params: Record<string, unknown>,
    label: string,
    flowPos?: Vec2,
  ): string | null {
    const state = get();
    const graph = currentGraph(state.asset, state.graphName);
    if (!state.asset || !graph) return null;
    const spec = state.specs.get(specId);
    const alloc = createIdAllocator([
      ...graph.nodes.map((n) => n.id),
      ...graph.edges.map((e) => e.id),
    ]);
    const newId = alloc.next(instancePrefixOf(specId) || 'node');
    const position = snapPosition(flowPos ?? staggeredPosition(graph.nodes.length));
    const ok = commit(label, (draft, ctx) => {
      const g = draft.graphs[ctx.graphName];
      if (!g) return;
      g.nodes.push({
        id: newId,
        type: specId,
        params: { ...(spec ? initialParams(spec) : {}), ...clone(params) },
        pinDefaults: spec ? initialPinDefaults(spec) : {},
        position,
      });
    });
    if (!ok) return null;
    get().pushRecentSpec(specId);
    set({ selection: { nodeIds: [newId], edgeIds: [] } });
    return newId;
  }

  return {
    asset: null,
    assetPath: null,
    graphName: '',
    specs: editorSpecMap(),
    selection: EMPTY_SELECTION,
    dirty: false,
    recentSpecIds: [],
    menu: null,
    toast: null,
    shakeAt: 0,
    validation: null,

    /* ---------------- 资产 / 视图（不进命令栈） ---------------- */

    openAsset(asset, assetPath) {
      // 注册命令域（重开资产会替换域状态并剔除本域旧历史，保证补丁可重放）
      registerDomainState('blueprint', { asset } satisfies BlueprintDomainState);
      const firstGraph = Object.keys(asset.graphs)[0] ?? '';
      set({
        asset,
        assetPath: assetPath ?? null,
        graphName: asset.entry in asset.graphs ? asset.entry : firstGraph,
        selection: EMPTY_SELECTION,
        dirty: false,
        menu: null,
        validation: null,
      });
    },

    switchGraph(graphName) {
      if (get().graphName === graphName) return;
      set({ graphName, selection: EMPTY_SELECTION, menu: null });
    },

    setSelection(selection) {
      set({ selection });
    },

    refreshFromDomain() {
      if (!isDomainRegistered('blueprint')) return;
      set({ asset: getDomainState<BlueprintDomainState>('blueprint').asset, dirty: true });
    },

    setSpecs(specs) {
      set({ specs });
    },

    markSaved() {
      set({ dirty: false });
    },

    setValidation(issues) {
      set({ validation: issues });
    },

    notify(text, kind = 'info') {
      set({ toast: { text, kind, at: Date.now() } });
    },

    dismissToast() {
      set({ toast: null });
    },

    shake() {
      set({ shakeAt: Date.now() });
    },

    openMenu(menu) {
      set({ menu });
    },

    closeMenu() {
      set({ menu: null });
    },

    pushRecentSpec(specId) {
      const next = pushRecent(get().recentSpecIds, specId);
      writeRecentStorage(next);
      set({ recentSpecIds: next });
    },

    loadRecentSpecs() {
      set({ recentSpecIds: readRecentStorage() });
    },

    /* ---------------- 编辑命令（全部可撤销） ---------------- */

    addNode(specId, flowPos) {
      return addNodeInternal(specId, flowPos, null);
    },

    addNodeConnected(specId, flowPos, from) {
      return addNodeInternal(specId, flowPos, from);
    },

    connect(source, target) {
      const { asset, graphName, specs } = get();
      const graph = currentGraph(asset, graphName);
      if (!asset || !graph) return false;
      const check = checkConnection(specs, graph.nodes, source, target);
      if (check.verdict === 'reject') {
        get().notify(check.message, 'error');
        get().shake();
        return false;
      }
      /** 目标输入引脚是否要顶掉旧线（数据引脚且非 multi；UE 语义） */
      const replacesIncoming = (to: IREndpoint): IREdge[] => {
        if (check.kind === 'exec') return [];
        const toNode = graph.nodes.find((n) => n.id === to.node);
        const pin = toNode ? specs.get(toNode.type)?.inputs.find((p) => p.id === to.pin) : undefined;
        if (!pin || pin.multi === true) return [];
        return graph.edges.filter((e) => e.to.node === to.node && e.to.pin === to.pin);
      };

      if (check.verdict === 'converter') {
        // 自动插入转换节点（§8.2 第 3 条）：一条命令建 转换节点 + 两条连线，撤销一次全还原
        const convSpec = specs.get(check.converterId);
        const fromNode = graph.nodes.find((n) => n.id === check.from.nodeId);
        const toNode = graph.nodes.find((n) => n.id === check.to.nodeId);
        if (!convSpec || !fromNode || !toNode) return false;
        const mid = snapPosition({
          x: (fromNode.position.x + toNode.position.x) / 2,
          y: (fromNode.position.y + toNode.position.y) / 2,
        });
        const alloc = createIdAllocator([
          ...graph.nodes.map((n) => n.id),
          ...graph.edges.map((e) => e.id),
        ]);
        const convId = alloc.next(instancePrefixOf(check.converterId));
        const edgeIn = alloc.next('e');
        const edgeOut = alloc.next('e');
        const dropped = replacesIncoming({ node: check.to.nodeId, pin: check.to.pinId });
        const ok = commit('自动插入转换节点', (draft, ctx) => {
          const g = draft.graphs[ctx.graphName];
          if (!g) return;
          g.nodes.push({
            id: convId,
            type: check.converterId,
            params: initialParams(convSpec),
            pinDefaults: initialPinDefaults(convSpec),
            position: mid,
          });
          const droppedIds = new Set(dropped.map((e) => e.id));
          g.edges = g.edges.filter((e) => !droppedIds.has(e.id));
          g.edges.push(
            { id: edgeIn, from: { node: check.from.nodeId, pin: check.from.pinId }, to: { node: convId, pin: 'value' }, kind: 'data' },
            { id: edgeOut, from: { node: convId, pin: 'value' }, to: { node: check.to.nodeId, pin: check.to.pinId }, kind: 'data' },
          );
        });
        if (ok) get().notify(`类型不匹配，已插入转换节点「${convSpec.title}」`);
        return ok;
      }

      // 直接连线：数据输入引脚（非 multi）新线顶旧线；exec 输入允许多线汇入
      const dropped = replacesIncoming(target);
      const edgeId = createIdAllocator(graph.edges.map((e) => e.id)).next('e');
      const label = check.kind === 'exec' ? '连接执行线' : '连接数据线';
      return commit(label, (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        const droppedIds = new Set(dropped.map((e) => e.id));
        g.edges = g.edges.filter((e) => !droppedIds.has(e.id));
        g.edges.push({
          id: edgeId,
          from: { node: source.node, pin: source.pin },
          to: { node: target.node, pin: target.pin },
          kind: check.kind,
        });
      });
    },

    disconnectEdges(edgeIds) {
      const ids = new Set(edgeIds);
      if (ids.size === 0) return;
      const { asset, graphName } = get();
      if (!currentGraph(asset, graphName)) return;
      const label = ids.size === 1 ? '断开连线' : `断开选中连线（${ids.size} 条）`;
      commit(label, (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        g.edges = g.edges.filter((e) => !ids.has(e.id));
      });
      set({ selection: { ...get().selection, edgeIds: [] } });
    },

    disconnectPin(nodeId, pinId, dir) {
      const { asset, graphName } = get();
      const graph = currentGraph(asset, graphName);
      if (!graph) return;
      const targetIds = new Set(
        graph.edges
          .filter((e) =>
            dir === 'out'
              ? e.from.node === nodeId && e.from.pin === pinId
              : e.to.node === nodeId && e.to.pin === pinId,
          )
          .map((e) => e.id),
      );
      if (targetIds.size === 0) return;
      commit(`断开引脚连线（${targetIds.size} 条）`, (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        g.edges = g.edges.filter((e) => !targetIds.has(e.id));
      });
    },

    deleteSelection() {
      const { asset, graphName, selection } = get();
      const graph = currentGraph(asset, graphName);
      if (!graph) return;
      const nodeIds = new Set(selection.nodeIds);
      const edgeIds = new Set(selection.edgeIds);
      if (nodeIds.size === 0 && edgeIds.size === 0) return;
      commit('删除选中', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        g.nodes = g.nodes.filter((n) => !nodeIds.has(n.id));
        g.edges = g.edges.filter(
          (e) => !nodeIds.has(e.from.node) && !nodeIds.has(e.to.node) && !edgeIds.has(e.id),
        );
      });
      set({ selection: EMPTY_SELECTION });
    },

    moveNodes(moves) {
      if (moves.length === 0) return;
      const { asset, graphName } = get();
      if (!currentGraph(asset, graphName)) return;
      const byId = new Map(moves.map((m) => [m.id, m.position]));
      commit('移动节点', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        for (const node of g.nodes) {
          const pos = byId.get(node.id);
          if (pos) node.position = { x: pos.x, y: pos.y };
        }
      });
    },

    setPinDefault(nodeId, pinId, value) {
      commit('设置引脚默认值', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        const node = g?.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        if (value === undefined) delete node.pinDefaults[pinId];
        else node.pinDefaults[pinId] = clone(value);
      });
    },

    setNodeParams(nodeId, params) {
      commit('设置节点参数', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        const node = g?.nodes.find((n) => n.id === nodeId);
        if (!node) return;
        for (const [key, value] of Object.entries(params)) {
          if (value === undefined) delete node.params[key];
          else node.params[key] = clone(value);
        }
      });
    },

    duplicateSelection(offset) {
      const inst = instantiateSelection(offset ?? { x: 20, y: 20 });
      if (!inst) return 0;
      return insertInstantiated('复制节点', inst);
    },

    async copySelection() {
      const { asset, graphName, selection } = get();
      const graph = currentGraph(asset, graphName);
      if (!asset || !graph || selection.nodeIds.length === 0) return 0;
      const picked = collectFragment(graph, new Set(selection.nodeIds));
      if (picked.nodes.length === 0) return 0;
      const fragment = buildFragment(picked.nodes, picked.edges, asset.variables);
      await writeFragment(fragment);
      get().notify(`已复制 ${picked.nodes.length} 个节点（Ctrl+V 粘贴）`);
      return picked.nodes.length;
    },

    async paste() {
      const fragment: IRFragment | null = await readFragment();
      if (!fragment || fragment.nodes.length === 0) {
        get().notify('剪贴板中没有可粘贴的蓝图片段');
        return 0;
      }
      const { asset, graphName } = get();
      const graph = currentGraph(asset, graphName);
      if (!asset || !graph) return 0;
      const inst = instantiateFragment(
        fragment,
        graph.nodes.map((n) => n.id),
        asset.variables,
        { x: 20, y: 20 },
      );
      return insertInstantiated('粘贴节点', inst);
    },

    addComment(_position, _text) {
      // TODO(T2.7)：注释框 Comment 节点（可调色 / 框选整体移动）——本卡仅留 action 占位
      get().notify('注释框将在 T2.7 提供');
    },

    /* ---------------- T2.3 My Blueprint：变量 ---------------- */

    addVariable(input) {
      const name = input.name.trim();
      if (name === '') {
        get().notify('变量名不能为空', 'error');
        return false;
      }
      const { asset } = get();
      if (!asset) return false;
      if (asset.variables.some((v) => nameKey(v.name) === nameKey(name))) {
        get().notify(`变量「${name}」已存在`, 'error');
        return false;
      }
      return commit('变量：新建', (draft) => {
        draft.variables.push({
          name,
          type: input.type,
          ...(input.default !== undefined ? { default: clone(input.default) } : {}),
          ...(input.exposed ? { exposed: true } : {}),
          ...(input.category ? { category: input.category } : {}),
        });
      });
    },

    renameVariable(oldName, newName) {
      const name = newName.trim();
      if (name === '') {
        get().notify('变量名不能为空', 'error');
        return false;
      }
      const { asset } = get();
      if (!asset) return false;
      if (!asset.variables.some((v) => v.name === oldName)) {
        get().notify(`变量「${oldName}」不存在`, 'error');
        return false;
      }
      if (asset.variables.some((v) => v.name !== oldName && nameKey(v.name) === nameKey(name))) {
        get().notify(`变量「${name}」已存在`, 'error');
        return false;
      }
      return commit('变量：重命名', (draft) => {
        const v = draft.variables.find((x) => x.name === oldName);
        if (v) v.name = name;
        // 级联：全部图中 var.get / var.set 实例的 varName 同步改名
        for (const g of Object.values(draft.graphs)) {
          for (const n of g.nodes) {
            if ((n.type === 'var.get' || n.type === 'var.set') && n.params['varName'] === oldName) {
              n.params['varName'] = name;
            }
          }
        }
      });
    },

    removeVariable(name) {
      commit('变量：删除', (draft) => {
        draft.variables = draft.variables.filter((v) => v.name !== name);
        // 级联：全部图中引用该变量的 Get/Set 节点及其挂接连线一并删除
        for (const g of Object.values(draft.graphs)) {
          const dead = new Set(
            g.nodes
              .filter(
                (n) =>
                  (n.type === 'var.get' || n.type === 'var.set') && n.params['varName'] === name,
              )
              .map((n) => n.id),
          );
          if (dead.size === 0) continue;
          g.nodes = g.nodes.filter((n) => !dead.has(n.id));
          g.edges = g.edges.filter((e) => !dead.has(e.from.node) && !dead.has(e.to.node));
        }
      });
    },

    updateVariable(name, patch) {
      commit('变量：编辑', (draft) => {
        const v = draft.variables.find((x) => x.name === name);
        if (!v) return;
        if (patch.type !== undefined) v.type = patch.type;
        if (patch.category !== undefined) {
          if (patch.category === '') delete v.category;
          else v.category = patch.category;
        }
        if (patch.exposed !== undefined) v.exposed = patch.exposed;
        if (patch.default !== undefined) v.default = clone(patch.default);
      });
    },

    duplicateVariable(name) {
      const { asset } = get();
      if (!asset) return null;
      const src = asset.variables.find((v) => v.name === name);
      if (!src) {
        get().notify(`变量「${name}」不存在`, 'error');
        return null;
      }
      const newName = nextCopyName(asset.variables.map((v) => v.name), name);
      const ok = commit('变量：复制', (draft) => {
        const v = draft.variables.find((x) => x.name === name);
        if (!v) return;
        draft.variables.push({ ...clone(v), name: newName });
      });
      return ok ? newName : null;
    },

    /* ---------------- T2.3 My Blueprint：函数 / 事件 ---------------- */

    addFunction(name) {
      const trimmed = name.trim();
      if (trimmed === '') {
        get().notify('函数名不能为空', 'error');
        return false;
      }
      const { asset } = get();
      if (!asset) return false;
      if (Object.keys(asset.graphs).some((k) => nameKey(k) === nameKey(trimmed))) {
        get().notify(`函数「${trimmed}」已存在`, 'error');
        return false;
      }
      return commit('函数：新建', (draft) => {
        // 函数子图骨架：入口 + 出口节点（数据脚由 IRGraph.params/returns 动态决定，见
        // my-blueprint/graph-op-specs.ts），接口声明留空数组（Details「图接口」区编辑）
        draft.graphs[trimmed] = {
          nodes: [
            { id: 'entry_1', type: 'func.entry', params: {}, pinDefaults: {}, position: { x: 0, y: 0 } },
            { id: 'return_1', type: 'func.return', params: {}, pinDefaults: {}, position: { x: 280, y: 0 } },
          ],
          edges: [],
          params: [],
          returns: [],
        };
      });
    },

    removeGraph(name) {
      const { asset } = get();
      if (!asset) return false;
      if (name === asset.entry) {
        get().notify('主图不能删除', 'error');
        return false;
      }
      if (!asset.graphs[name]) return false;
      return commit('函数：删除', (draft) => {
        delete draft.graphs[name];
        // 级联：全部图中指向它的 flow.call 节点及其挂接连线一并删除
        for (const g of Object.values(draft.graphs)) {
          const dead = new Set(
            g.nodes
              .filter((n) => n.type === 'flow.call' && n.params['graph'] === name)
              .map((n) => n.id),
          );
          if (dead.size === 0) continue;
          g.nodes = g.nodes.filter((n) => !dead.has(n.id));
          g.edges = g.edges.filter((e) => !dead.has(e.from.node) && !dead.has(e.to.node));
        }
      });
    },

    addEvent(def) {
      const name = def.name.trim();
      if (name === '') {
        get().notify('事件名不能为空', 'error');
        return false;
      }
      const { asset } = get();
      if (!asset) return false;
      if (asset.events.some((e) => nameKey(e.name) === nameKey(name))) {
        get().notify(`事件「${name}」已存在`, 'error');
        return false;
      }
      return commit('事件：新建', (draft) => {
        draft.events.push({ name, params: clone(def.params ?? []) });
      });
    },

    updateEvent(name, patch) {
      const { asset } = get();
      if (!asset) return false;
      if (!asset.events.some((e) => e.name === name)) {
        get().notify(`事件「${name}」不存在`, 'error');
        return false;
      }
      const newName = patch.name?.trim();
      if (newName !== undefined && newName === '') {
        get().notify('事件名不能为空', 'error');
        return false;
      }
      if (
        newName !== undefined &&
        newName !== name &&
        asset.events.some((e) => nameKey(e.name) === nameKey(newName))
      ) {
        get().notify(`事件「${newName}」已存在`, 'error');
        return false;
      }
      return commit('事件：编辑', (draft) => {
        const e = draft.events.find((x) => x.name === name);
        if (!e) return;
        if (newName !== undefined) e.name = newName;
        if (patch.params !== undefined) e.params = clone(patch.params);
        // 级联：event.custom 实例的 params.eventName 同步改名（绑定约定见解释器 T2.5）
        if (newName !== undefined && newName !== name) {
          for (const g of Object.values(draft.graphs)) {
            for (const n of g.nodes) {
              if (n.type === 'event.custom' && n.params['eventName'] === name) {
                n.params['eventName'] = newName;
              }
            }
          }
        }
      });
    },

    /* ---------------- T2.3 My Blueprint：插入节点 ---------------- */

    insertVariableNode(varName, op, flowPos) {
      const { asset } = get();
      if (!asset || !asset.variables.some((v) => v.name === varName)) {
        get().notify(`变量「${varName}」未定义`, 'error');
        return null;
      }
      return insertOwnedNode(
        op === 'set' ? 'var.set' : 'var.get',
        { varName },
        op === 'set' ? '插入变量 Set 节点' : '插入变量 Get 节点',
        flowPos,
      );
    },

    insertFunctionCall(graphName, flowPos) {
      const { asset } = get();
      if (!asset?.graphs[graphName]) {
        get().notify(`函数「${graphName}」不存在`, 'error');
        return null;
      }
      return insertOwnedNode('flow.call', { graph: graphName }, '插入函数调用节点', flowPos);
    },

    insertEventNode(eventName, flowPos) {
      const { asset } = get();
      if (!asset?.events.some((e) => e.name === eventName)) {
        get().notify(`事件「${eventName}」未定义`, 'error');
        return null;
      }
      return insertOwnedNode('event.custom', { eventName }, '插入事件节点', flowPos);
    },

    /* ---------------- T2.3/T2.4：图接口与批量编辑 ---------------- */

    setGraphParams(graphName, params) {
      commit('编辑函数入参', (draft) => {
        const g = draft.graphs[graphName];
        if (!g) return;
        g.params = clone(params);
      });
    },

    setGraphReturns(graphName, returns) {
      commit('编辑函数返回值', (draft) => {
        const g = draft.graphs[graphName];
        if (!g) return;
        g.returns = clone(returns);
      });
    },

    setNodesParams(nodeIds, params) {
      const ids = new Set(nodeIds);
      if (ids.size === 0) return;
      commit('批量设置节点参数', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        for (const node of g.nodes) {
          if (!ids.has(node.id)) continue;
          for (const [key, value] of Object.entries(params)) {
            if (value === undefined) delete node.params[key];
            else node.params[key] = clone(value);
          }
        }
      });
    },
  };
});

/* ============================================================
 * 便捷选择器（组件层用；返回新数组的selector注意配合浅比较）
 * ============================================================ */

/** 当前图（不存在返回 null） */
export function selectCurrentGraph(state: BlueprintStore) {
  return state.asset?.graphs[state.graphName] ?? null;
}

/** 引脚拖出菜单的兼容条目（strict：只列可直接接入的节点，§8.2 第 2 条） */
export function selectPinMenuEntries(state: BlueprintStore): SpecEntry[] {
  if (state.menu?.kind !== 'pin') return [];
  return compatibleSpecEntries(state.specs, state.menu.from);
}

/** 右键搜索的全量条目（NodeSearchMenu 渲染用，匹配交给 searchSpecEntries） */
export function selectSearchEntries(state: BlueprintStore): SpecEntry[] {
  return [...state.specs.values()].map((spec) => ({ spec, pin: null }));
}
