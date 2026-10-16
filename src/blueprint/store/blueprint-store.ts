/**
 * Blueprint Studio v2 —— 蓝图编辑状态（T2.2 组装 / T2.3 资产级编辑扩充，PLAN §6.3 命令栈 / §8.2 交互）
 *
 * 职责划分：
 *  - **命令栈域状态**（唯一文档真源）：registerDomainState('blueprint', { asset })，
 *    全部图编辑（增删节点 / 连线 / 移动 / 参数 / 引脚默认值 / 粘贴）、
 *    T2.3 结构面板资产编辑（变量 / 函数图 / 自定义事件 / 图接口 / 批量参数）与
 *    T2.7 注释框编辑（新建 / 移动含节点 / 调整大小 / 改文本颜色 / 删除）经
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
  IRCommentBounds,
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
  clampCommentBounds,
  commentIdFromSelectionId,
  commentSelectionId,
  COMMENT_SELECTION_PREFIX,
  containedNodeIds,
  DEFAULT_COMMENT_SIZE,
  estimatedNodeSizeOf,
  staggeredCommentPosition,
  type NodeSizeResolver,
} from '../comment/model';
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
  | ({ kind: 'comment'; commentId: string } & MenuPos)
  | null;

/** 注释框定位请求（My Blueprint 双击跳转；面板监听后切图 + 居中 + 选中） */
export interface CommentFocusRequest {
  /** 注释所在图名 */
  graphName: string;
  /** 注释 id */
  commentId: string;
  /** 请求戳（同一注释重复双击也能再次触发） */
  at: number;
}

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
  /** 注释框定位请求（My Blueprint 双击跳转 / 校验跳转同款；面板监听后居中定位） */
  focusComment: CommentFocusRequest | null;

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
  /** 请求定位某注释框（My Blueprint 双击跳转；at 戳保证同一注释可重复触发） */
  requestCommentFocus(commentId: string): void;

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

  /* ---------------- T2.7 注释框（ADR-006；全部入命令栈，label「注释：…」） ---------------- */
  /**
   * 新建注释框（画布右键「添加注释」/ My Blueprint「＋」共用）；返回新注释 id。
   * position 省略时按注释数错开落点；创建后注释框进入选中集。
   */
  addComment(position?: Vec2, text?: string): string | null;
  /**
   * 移动注释框（拖标题/松手提交；一次命令同时平移「完全包含」的节点，UE5 同款）。
   * nodeSizes 为实测尺寸表（节点 id → 宽高）；缺项回落按节点头变体估算。
   */
  moveComment(
    commentId: string,
    bounds: IRCommentBounds,
    nodeSizes?: ReadonlyMap<string, { width: number; height: number }>,
  ): void;
  /** 调整注释框大小（拖角 resize；不移动内含节点，UE 同款） */
  resizeComment(commentId: string, bounds: IRCommentBounds): void;
  /** 注释文本（双击标题行内编辑；空白文本拒绝）；成功返回 true */
  setCommentText(commentId: string, text: string): boolean;
  /** 注释颜色（预设色板 / 自定义取色器；undefined = 恢复主题默认灰） */
  setCommentColor(commentId: string, color: string | undefined): void;
  /** 注释大小重置（保持左上角，恢复默认尺寸） */
  resetCommentSize(commentId: string): void;
  /** 删除注释框（仅删注释，不动节点；支持批量） */
  removeComments(commentIds: readonly string[]): void;

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
    focusComment: null,

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
        focusComment: null,
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

    requestCommentFocus(commentId) {
      const { asset } = get();
      if (!asset) return;
      for (const [graphName, graph] of Object.entries(asset.graphs)) {
        if (graph.comments?.some((c) => c.id === commentId)) {
          set({ focusComment: { graphName, commentId, at: Date.now() } });
          return;
        }
      }
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
      // 选中集里 'comment:' 前缀的 id 是注释框（T2.7），其余为节点实例 id
      const commentIds = new Set(
        selection.nodeIds
          .map(commentIdFromSelectionId)
          .filter((id): id is string => id !== null),
      );
      const nodeIds = new Set(
        selection.nodeIds.filter((id) => !id.startsWith(COMMENT_SELECTION_PREFIX)),
      );
      const edgeIds = new Set(selection.edgeIds);
      if (nodeIds.size === 0 && edgeIds.size === 0 && commentIds.size === 0) return;
      const onlyComments = nodeIds.size === 0 && edgeIds.size === 0;
      const label = onlyComments
        ? commentIds.size === 1
          ? '注释：删除'
          : `注释：删除（${commentIds.size} 个）`
        : '删除选中';
      commit(label, (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        // 注释只删自身，不级联节点（UE 同款）
        if (commentIds.size > 0 && g.comments) {
          g.comments = g.comments.filter((c) => !commentIds.has(c.id));
        }
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

    /* ---------------- T2.7 注释框（ADR-006；全部入命令栈，label「注释：…」） ---------------- */

    addComment(position, text) {
      const { asset, graphName } = get();
      const graph = currentGraph(asset, graphName);
      if (!asset || !graph) return null;
      // id 在命令前分配（确定性；与节点 id 同空间去重，避免撞名）
      const alloc = createIdAllocator([
        ...graph.nodes.map((n) => n.id),
        ...(graph.comments ?? []).map((c) => c.id),
      ]);
      const id = alloc.next('comment');
      const pos = snapPosition(position ?? staggeredCommentPosition(graph.comments?.length ?? 0));
      const trimmed = text?.trim();
      const ok = commit('注释：新建', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        if (!g.comments) g.comments = [];
        g.comments.push({
          id,
          text: trimmed ? trimmed : '注释',
          bounds: { x: pos.x, y: pos.y, w: DEFAULT_COMMENT_SIZE.w, h: DEFAULT_COMMENT_SIZE.h },
        });
      });
      if (!ok) return null;
      set({ selection: { nodeIds: [commentSelectionId(id)], edgeIds: [] } });
      return id;
    },

    moveComment(commentId, bounds, nodeSizes) {
      const { asset, graphName, specs } = get();
      const graph = currentGraph(asset, graphName);
      if (!asset || !graph) return;
      const comment = graph.comments?.find((c) => c.id === commentId);
      if (!comment) return;
      const next = clampCommentBounds(bounds);
      const from = comment.bounds;
      const dx = next.x - from.x;
      const dy = next.y - from.y;
      if (dx === 0 && dy === 0 && next.w === from.w && next.h === from.h) return;
      // 包含判定以「移动前」的 bounds 与节点位置为准（拖拽预览只改视图，不写 store，二者一致）。
      // 尺寸解析：实测（ReactFlow measured）优先，缺项按节点头变体估算兜底。
      const fallback = estimatedNodeSizeOf(specs);
      const sizeOf: NodeSizeResolver = (node) => {
        const m = nodeSizes?.get(node.id);
        if (m && m.width > 0 && m.height > 0) return { width: m.width, height: m.height };
        return fallback(node);
      };
      const contained = new Set(containedNodeIds(from, graph.nodes, sizeOf));
      commit('注释：移动', (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g) return;
        const c = g.comments?.find((x) => x.id === commentId);
        if (!c) return;
        c.bounds = { ...next };
        // 完全包含的节点随注释一起平移（同一命令，撤销一步全还原；相交但不完全包含的不动）
        for (const node of g.nodes) {
          if (!contained.has(node.id)) continue;
          node.position = { x: node.position.x + dx, y: node.position.y + dy };
        }
      });
    },

    resizeComment(commentId, bounds) {
      const { asset, graphName } = get();
      const graph = currentGraph(asset, graphName);
      if (!graph) return;
      if (!graph.comments?.some((c) => c.id === commentId)) return;
      const next = clampCommentBounds(bounds);
      commit('注释：调整大小', (draft, ctx) => {
        const c = draft.graphs[ctx.graphName]?.comments?.find((x) => x.id === commentId);
        if (!c) return;
        c.bounds = { ...next }; // 只改注释框；内含节点不随 resize 移动（UE 同款）
      });
    },

    setCommentText(commentId, text) {
      const trimmed = text.trim();
      if (trimmed === '') {
        get().notify('注释文本不能为空', 'error');
        return false;
      }
      const { asset, graphName } = get();
      if (!asset?.graphs[graphName]?.comments?.some((c) => c.id === commentId)) {
        get().notify('注释不存在', 'error');
        return false;
      }
      return commit('注释：重命名', (draft, ctx) => {
        const c = draft.graphs[ctx.graphName]?.comments?.find((x) => x.id === commentId);
        if (c) c.text = trimmed;
      });
    },

    setCommentColor(commentId, color) {
      commit('注释：改颜色', (draft, ctx) => {
        const c = draft.graphs[ctx.graphName]?.comments?.find((x) => x.id === commentId);
        if (!c) return;
        if (color === undefined) delete c.color;
        else c.color = color;
      });
    },

    resetCommentSize(commentId) {
      commit('注释：大小重置', (draft, ctx) => {
        const c = draft.graphs[ctx.graphName]?.comments?.find((x) => x.id === commentId);
        if (!c) return;
        c.bounds = { x: c.bounds.x, y: c.bounds.y, w: DEFAULT_COMMENT_SIZE.w, h: DEFAULT_COMMENT_SIZE.h };
      });
    },

    removeComments(commentIds) {
      const ids = new Set(commentIds);
      if (ids.size === 0) return;
      const { asset, graphName } = get();
      if (!asset?.graphs[graphName]?.comments) return;
      const label = ids.size === 1 ? '注释：删除' : `注释：删除（${ids.size} 个）`;
      // 仅删注释，节点与连线一律不动（UE 同款：注释只是视觉容器）
      commit(label, (draft, ctx) => {
        const g = draft.graphs[ctx.graphName];
        if (!g?.comments) return;
        g.comments = g.comments.filter((c) => !ids.has(c.id));
      });
      set({ selection: EMPTY_SELECTION });
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
