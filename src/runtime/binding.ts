/**
 * Blueprint Studio v2 —— 蓝图绑定 UI 节点 + 事件驱动运行（T2.6 · PLAN §4.2 / §11 / §12）
 *
 * 职责（编辑器不参与，全部在运行窗口侧）：
 *  1. 绑定发现：遍历 UIAsset 树收集 logicAsset 节点（props.logicAsset 优先，回落顶层
 *     UINode.logicAsset——检视器 T2.6 双写两处，模板资产只写顶层），按路径去重分组。
 *  2. 蓝图加载：每个唯一路径 GET /api/file → deserializeIR → createRuntime(asset,
 *     editorSpecMap(), { ui, print, onError, onDebug, vars })（T2.5 解释器 + ADR-005 句柄）。
 *  3. UiHandle（ADR-005，ui 访问器 = 绑定节点子树）：find 按名查子树返回轻量节点对象；
 *     read 实时 DOM 值优先（input.value / checkbox.checked / textContent），元素缺失回落
 *     UINode.props；write 简单属性直改 DOM + 同步内存 props，结构型属性（items 等）改内存
 *     后经 updateUI 增量重建（T1.2 keyed reconcile）；name 不存在经 onMissing 打印提示。
 *  4. 事件驱动：renderUI 的 onEvent → 路由到持有该节点的 runtime：rt.emit(事件名, payload)
 *     （内建事件 pressed / textChanged… 直接作为事件名，蓝图 event.custom 以
 *     params.eventName 绑定即触发；载荷统一包成 { value }）；runner 加载完成后逐实例
 *     start() 触发 event.start。
 *  5. 事件总线（T5.1 正式化）：中央 EventBus——解释器每次事件出队都发 onDebug({kind:'emit'})
 *     （T2.5 契约，零侵入），经 runtimeEventSink 回灌总线；总线按 target（node/ui/all）
 *     路由到其它 runtime，环保护（回声令牌 + 跳数上限 8）解决 A↔B 互 relay 死循环；
 *     'start' 不广播。跨 UI 广播：多个 BindingRunner 可经 opts.bus 注入同一总线实例。
 *
 * 与 T3.3（脚本沙箱）的等价接入：加载 .bp.json 的一步替换为「取 .ts/.py → 服务端转译 /
 * 解析为同一 IR」，其后 createRuntime 起的实例、UiHandle、事件路由、总线全部复用本模块。
 * .ts 路径（T3.3 已落地）：GET /api/file 取源码 → POST /api/transpile（服务端 esbuild，
 * PLAN §9.2——拿语法级错误 / 警告与缓存）→ parseScriptToIR(源码) 得同一 IRAsset
 * （D3 单一 IR 路径：执行用源码解析，不用转译产物）→ 与蓝图共用 createRuntime；
 * .py 路径本期只提示（Python 运行时 T4.1 Pyodide 接入），不报错不崩溃。
 *
 * 注意：本文件不 import CSS；render 目录只读（import，不改）。
 */
import type { IRAsset, UINode, UIAsset, UiHandle } from '@/ir/types';
import { deserializeIR } from '@/ir/validate';
import { editorSpecMap } from '@/blueprint/my-blueprint/graph-op-specs';
import { injectSnippetRuntime } from '@/script/snippet-runtime';
import type { UIRenderEvent, UIRenderHandle } from './render/render';
import { updateUI } from './render/render';
import { createRuntime, type DebugEvent, type RuntimeHandle } from './interpreter';
import { createEventBus, runtimeEventSink, type EventBus } from './events';

/* ============================================================
 * 1. 绑定发现（纯函数，可单测）
 * ============================================================ */

/** 一组绑定：同一逻辑资产路径 → 绑定它的节点集合（子树根） */
export interface LogicBinding {
  /** 逻辑资产路径（相对项目根，如 'logic/main.bp.json'） */
  path: string;
  /** 绑定该资产的节点（子树根；多个节点可绑同一资产） */
  nodes: UINode[];
}

/**
 * 解析节点的绑定路径：props.logicAsset（检视器写入位，非空才生效）优先，
 * 回落顶层 UINode.logicAsset（ir 契约位，模板资产形态）；两者皆空 = 未绑定。
 */
export function resolveBoundPath(node: UINode): string | undefined {
  const p = node.props?.logicAsset;
  if (typeof p === 'string' && p !== '') return p;
  const top = node.logicAsset;
  if (typeof top === 'string' && top !== '') return top;
  return undefined;
}

/** 递归收集绑定节点（先序遍历；同节点只计一次） */
function walkBound(node: UINode, out: UINode[]): void {
  if (resolveBoundPath(node) !== undefined) out.push(node);
  for (const child of node.children ?? []) walkBound(child, out);
}

/**
 * 收集 UIAsset 中全部 logicAsset 绑定并按路径去重分组（DoD 单测 1）。
 * 返回顺序 = 树先序中路径首次出现的顺序；无绑定时返回空数组。
 */
export function collectBoundNodes(asset: UIAsset): LogicBinding[] {
  const nodes: UINode[] = [];
  walkBound(asset.root, nodes);
  const byPath = new Map<string, LogicBinding>();
  for (const node of nodes) {
    const path = resolveBoundPath(node)!;
    const hit = byPath.get(path);
    if (hit) hit.nodes.push(node);
    else byPath.set(path, { path, nodes: [node] });
  }
  return [...byPath.values()];
}

/* ============================================================
 * 2. 空蓝图模板（检视器「新建」用；形状对齐 templates/log-analyzer/logic/main.bp.json）
 * ============================================================ */

/**
 * 生成一份空蓝图 IR：主图名 'bind'（绑定入口约定），内含一个 event.start 节点；
 * 变量 / 事件 / 片段为空，layout 给 bind 图的默认视图状态。
 */
export function emptyBlueprintAsset(name: string): IRAsset {
  return {
    version: 2,
    name,
    entry: 'bind',
    graphs: {
      bind: {
        nodes: [
          {
            id: 'n_start',
            type: 'event.start',
            params: {},
            pinDefaults: {},
            position: { x: 120, y: 200 },
            comment: 'start 事件（BeginPlay 同义）：运行窗口加载 UI 后触发',
          },
        ],
        edges: [],
      },
    },
    variables: [],
    events: [],
    snippets: [],
    layout: { bind: { zoom: 1, pan: [0, 0] } },
  };
}

/* ============================================================
 * 3. logicRef 选项列表（检视器选择器用；tree → .bp.json 列表，纯函数可单测）
 * ============================================================ */

/** 下拉选项（value = 项目内相对路径，即 UINode.logicAsset 的存储值） */
export interface LogicOption {
  value: string;
  label: string;
}

/** GET /api/tree 响应中的目录树节点（server/fs.ts TreeNode 的结构子集） */
export interface TreeEntryLike {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  children?: unknown;
}

/**
 * 从 /api/tree（path=<project>/logic）响应构建 .bp.json 选项列表（DoD 单测 5）：
 * - 递归收集 name 以 '.bp.json' 结尾的文件（任意子目录），且路径必须位于
 *   `${project}/logic/` 之下（容错：即使服务端返回了更大范围的树也只取 logic 域）；
 * - value = 树路径去掉 `${project}/` 前缀（即项目内相对路径）；
 * - 容错：响应 / 节点形状不合法返回空数组（不抛错）。
 */
export function buildLogicAssetOptions(treeResponse: unknown, project: string): LogicOption[] {
  const tree = (treeResponse as { tree?: unknown } | null | undefined)?.tree;
  const prefix = `${project}/`;
  const scope = `${project}/logic/`;
  const out: LogicOption[] = [];
  const walk = (entry: unknown): void => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as TreeEntryLike;
    if (typeof e.path !== 'string' || e.path === '') return;
    if (e.type === 'file') {
      if (
        typeof e.name === 'string' &&
        e.name.toLowerCase().endsWith('.bp.json') &&
        e.path.startsWith(scope)
      ) {
        const rel = e.path.slice(prefix.length);
        out.push({ value: rel, label: rel });
      }
      return;
    }
    const children = Array.isArray(e.children) ? e.children : [];
    for (const child of children) walk(child);
  };
  walk(tree);
  return out;
}

/* ============================================================
 * 4. UiHandle（ADR-005：ui 访问器 = 绑定节点子树）
 * ============================================================ */

/** 值字符串化（与渲染器 str 同语义） */
function strOf(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** 在 scopes（绑定节点子树根列表）内按 name 查找节点（先到先得） */
function findNodeByName(scopes: readonly UINode[], name: string): UINode | null {
  const walk = (node: UINode): UINode | null => {
    if (node.name === name) return node;
    for (const child of node.children ?? []) {
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  for (const scope of scopes) {
    const hit = walk(scope);
    if (hit) return hit;
  }
  return null;
}

/** 控件焦点让步（与渲染器 setControlValue 同语义：用户输入中不覆盖） */
function setControlValue(ctrl: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (ctrl.value === value) return;
  if (ctrl.ownerDocument?.activeElement === ctrl) return;
  ctrl.value = value;
}

/** 表单控件判定（tagName 鸭子类型——不依赖全局构造器，happy-dom / 多窗口环境同样成立） */
function isFormControl(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** checkbox 判定（tagName 鸭子类型，同上） */
function isCheckbox(el: HTMLElement): el is HTMLInputElement {
  return el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'checkbox';
}

/** 文本输入判定（input / textarea 可 setControlValue；select 走 value 赋值） */
function isTextInput(
  ctrl: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
): ctrl is HTMLInputElement | HTMLTextAreaElement {
  return ctrl.tagName === 'INPUT' || ctrl.tagName === 'TEXTAREA';
}

/** 找元素自身或内部的第一个控件 */
function controlOf(el: HTMLElement): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null {
  if (isFormControl(el)) return el;
  return el.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
    'input, textarea, select',
  );
}

export interface UiHandleOptions {
  /** 绑定节点子树根列表（同一资产可绑定多个节点） */
  scopes: readonly UINode[];
  /** 取节点当前 DOM 元素（renderUI 根内按 data-uid 查找；缺失返回 null） */
  getEl: (node: UINode) => HTMLElement | null;
  /** 结构型写入后的增量刷新（= updateUI(renderHandle, asset)，T1.2 keyed reconcile） */
  refresh: () => void;
  /** name 不存在 / 降级提示（runner 接 print 通道） */
  onMissing: (message: string) => void;
}

/**
 * 构造 ADR-005 的 UiHandle（DoD 单测 2）。
 * - find：子树内按 name 找，返回轻量节点对象 { name, type, props }（props 为活引用）；
 * - read：实时 DOM 值优先（value→控件值 / checked→勾选 / text→控件值或文本 / title /
 *   placeholder→属性 / visible→渲染标记），元素缺失或属性不可 DOM 映射回落 UINode.props；
 * - write：简单属性（text/value/checked/title/placeholder/visible）直改 DOM + 同步内存
 *   props；其余（items 等结构型）改内存 props 后 refresh() 增量重建；name 不存在 → onMissing。
 */
export function makeUiHandle(opts: UiHandleOptions): UiHandle {
  const { scopes, getEl, refresh, onMissing } = opts;

  const find = (name: string): unknown => {
    const node = findNodeByName(scopes, name);
    if (!node) return null;
    return { name: node.name, type: node.type, props: node.props };
  };

  const read = (name: string, attr: string): unknown => {
    const node = findNodeByName(scopes, name);
    if (!node) {
      onMissing(`ui.read：绑定子树中未找到节点「${name}」（已返回 undefined）`);
      return undefined;
    }
    const el = getEl(node);
    if (el) {
      switch (attr) {
        case 'value': {
          const ctrl = controlOf(el);
          if (ctrl) return ctrl.value;
          break;
        }
        case 'checked': {
          const box = isCheckbox(el) ? el : el.querySelector<HTMLInputElement>('input[type=checkbox]');
          if (box) return box.checked;
          break;
        }
        case 'text': {
          const ctrl = controlOf(el);
          if (ctrl) return ctrl.value; // 输入控件的 text 即实时输入值
          return el.textContent ?? '';
        }
        case 'title':
          return el.getAttribute('title') ?? '';
        case 'placeholder': {
          const ctrl = controlOf(el);
          return ctrl?.getAttribute('placeholder') ?? '';
        }
        case 'visible':
          return el.dataset.visible !== 'false'; // 渲染器维护的标记（applyCommon）
        default:
          break;
      }
    }
    // 元素缺失 / 属性不可 DOM 映射：回落内存 props
    return node.props?.[attr];
  };

  const write = (name: string, attr: string, value: unknown): void => {
    const node = findNodeByName(scopes, name);
    if (!node) {
      onMissing(`ui.write：绑定子树中未找到节点「${name}」，写入被忽略（attr=${attr}）`);
      return;
    }
    if (!node.props) node.props = {};
    node.props[attr] = value; // 内存 props 始终同步（后续 updateUI 不会回退）
    const el = getEl(node);
    if (!el) return; // 无 DOM（未渲染 / 已销毁）：内存已更新，够用
    switch (attr) {
      case 'text':
      case 'value': {
        // 输入控件（input/textarea）的实时值即 props.text（渲染器重放真源），text/value 视为同义
        // 同写两键保证后续 updateUI 不回退；select 的值属性是 props.value；
        // 其余类型：text=文本内容（button/label 直改，结构型交渲染器），value 走渲染器。
        if (isFormControl(el)) {
          if (isTextInput(el)) {
            setControlValue(el, strOf(value));
            node.props.text = value;
            node.props.value = value;
          } else {
            el.value = strOf(value);
            node.props.value = value;
          }
        } else if (attr === 'text' && node.type === 'button') {
          el.textContent = strOf(value) || '按钮'; // 与渲染器 patch 同语义（空文本回落「按钮」）
        } else if (attr === 'text' && node.type === 'checkBox') {
          const t = el.querySelector<HTMLElement>('.bps-check-text');
          if (t) t.textContent = strOf(value);
        } else if (attr === 'text' && node.type === 'label') {
          el.textContent = strOf(value);
        } else {
          refresh(); // richText / markdown / panel 标题等结构型文本交给渲染器
        }
        break;
      }
      case 'checked': {
        const box = isCheckbox(el) ? el : el.querySelector<HTMLInputElement>('input[type=checkbox]');
        if (box) box.checked = value === true;
        else refresh();
        break;
      }
      case 'title': {
        const v = strOf(value);
        if (v) el.setAttribute('title', v);
        else el.removeAttribute('title');
        break;
      }
      case 'placeholder': {
        const ctrl = controlOf(el);
        if (ctrl && isTextInput(ctrl)) {
          if (strOf(value)) ctrl.setAttribute('placeholder', strOf(value));
          else ctrl.removeAttribute('placeholder');
        } else {
          refresh();
        }
        break;
      }
      case 'visible': {
        const visible = value !== false;
        el.dataset.visible = visible ? 'true' : 'false';
        el.style.display = visible ? '' : 'none';
        break;
      }
      default:
        refresh(); // items 等结构型属性：经 T1.2 updateUI 增量重建
        break;
    }
  };

  return { find, read, write };
}

/* ============================================================
 * 5. 跨蓝图事件广播 hub
 * ============================================================ */

/** 转发事件标记（接收方 dispatch 再次进入 hub 时据此识别回声，防自转发循环） */
export const HUB_ECHO_KEY = '__bpHubEcho';

/** 不广播的内部事件名（start 是生命周期事件，逐实例自行触发） */
const HUB_SKIP_EVENTS: ReadonlySet<string> = new Set(['start']);

/**
 * 中央事件 hub（T2.6 遗留的最小实现，已由 T5.1 事件总线正式化取代）：
 * 解释器每次事件出队都发 onDebug({ kind: 'emit', message: 事件名, value: 参数 })——
 * hub 据此把事件转发给其它 runtime（emit 超出自身 → 其它蓝图也收）。
 * 转发事件带 HUB_ECHO_KEY 标记；接收方 runtime 再出队该事件时 hub 识别回声不再转发。
 * 保留导出仅为 T2.6 单测与旧消费方兼容；BindingRunner 已改用 ./events 的事件总线。
 */
export class BlueprintEventHub {
  private readonly members = new Map<string, RuntimeHandle>();

  /** 登记一个 runtime（tag 唯一；重复登记覆盖） */
  add(tag: string, rt: RuntimeHandle): void {
    this.members.set(tag, rt);
  }

  /** 移除（stop 后调用，防悬挂引用） */
  remove(tag: string): void {
    this.members.delete(tag);
  }

  /**
   * 转发一条事件到除来源外的全部 runtime。
   * args 带 HUB_ECHO_KEY（转发事件的回声）或事件名为 start（生命周期）时跳过。
   */
  forward(fromTag: string, name: string, args?: Record<string, unknown>): void {
    if (!name || HUB_SKIP_EVENTS.has(name)) return;
    if (args && typeof args === 'object' && HUB_ECHO_KEY in args) return;
    for (const [tag, rt] of this.members) {
      if (tag === fromTag) continue;
      rt.emit(name, { ...(args ?? {}), [HUB_ECHO_KEY]: fromTag });
    }
  }
}

/**
 * 构造接 hub 的 onDebug 回调（createRuntime opts 用）：
 * 只关心 kind='emit'（事件出队）；message=事件名、value=事件参数。
 */
export function hubDebugSink(tag: string, hub: BlueprintEventHub): (ev: DebugEvent) => void {
  return (ev) => {
    if (ev.kind !== 'emit') return;
    const args = ev.value && typeof ev.value === 'object' ? (ev.value as Record<string, unknown>) : undefined;
    hub.forward(tag, ev.message ?? '', args);
  };
}

/* ============================================================
 * 6. 绑定运行器（RuntimeApp 接线）
 * ============================================================ */

/** 变量初值（DoD ③）：各变量 default（未声明 default 的交给解释器按类型零值起） */
function varsFromIR(ir: IRAsset): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const v of ir.variables ?? []) {
    if (v.default !== undefined) out[v.name] = v.default;
  }
  return out;
}

/** 一个已启动的绑定实例 */
interface RuntimeEntry {
  /** hub 登记 tag（加载失败会跳过序号，tag 与数组下标不对应，须随条目保存） */
  tag: string;
  path: string;
  ir: IRAsset;
  rt: RuntimeHandle;
  /** 绑定子树内全部节点名（事件路由用） */
  nameSet: ReadonlySet<string>;
  /** 控制台前缀的资产种类名（蓝图 / 脚本，T3.3 起随扩展名判定） */
  kindLabel: string;
}

export interface BindingRunnerOptions {
  /** 项目文件夹名（/api/file 安全根首段） */
  project: string;
  /** 已渲染的 UI 资产（与 renderUI 用同一对象引用，refresh 才能增量生效） */
  asset: UIAsset;
  /** 渲染句柄（UiHandle 直改 DOM 的查找根 + refresh 的 updateUI 凭据） */
  renderHandle: UIRenderHandle;
  /** fetch 替身（测试用；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
  /** 控制台行输出（print / 生命周期 / 错误行统一走这里；错误行带 [错误] / [绑定] 前缀） */
  onPrint?: (line: string) => void;
  /** 错误上报（蓝图加载失败 / 节点执行错误；详细行已走 onPrint，此处供消费方展开控制台等） */
  onError?: (message: string) => void;
  /** 事件总线（T5.1；注入同一实例即可跨 UI 实例广播——多运行窗口共用；缺省自建） */
  bus?: EventBus;
  /** 本运行器的 UI 实例 id（总线 target='ui' 的分组依据；缺省 'default'） */
  uiId?: string;
  /** 调试观察探针（T5.4，运行窗口注入）：present 时各实例 onDebug 追加推入观察通道（150ms 批量见 ./debug-probe.ts）；缺省不接 */
  debugProbe?: DebugProbeLike;
}

/**
 * 调试观察探针最小接口（T5.4）：与 ./debug-probe.ts 的 DebugProbe 结构兼容，
 * 只声明 push 入口——binding 不 import 具体实现，测试可用轻量替身。
 */
export interface DebugProbeLike {
  /** 推入一条调试事件（内部按 assetPath 分通道 150ms 批量） */
  push(assetPath: string, ev: DebugEvent): void;
}

/**
 * 聚合 onDebug 回调（T5.4 接线点·独立小函数，**不触碰 loadAndStart 加载分支**——
 * T3.3 的并行改动集中在加载处（assetKindOf / loadScriptIR），合并时只需保留
 * 本函数与 createRuntime opts 里 onDebug 的调用行）：
 * 事件总线回灌（runtimeEventSink）恒在；注入 probe 时追加 probe.push(assetPath, ev)。
 */
export function composeDebugSink(
  base: (ev: DebugEvent) => void,
  probe: DebugProbeLike | undefined,
  assetPath: string,
): (ev: DebugEvent) => void {
  if (!probe) return base;
  return (ev) => {
    base(ev);
    probe.push(assetPath, ev);
  };
}

/** 收集绑定子树内全部节点名 */
function collectNames(scopes: readonly UINode[]): ReadonlySet<string> {
  const names = new Set<string>();
  const walk = (node: UINode): void => {
    names.add(node.name);
    for (const child of node.children ?? []) walk(child);
  };
  for (const scope of scopes) walk(scope);
  return names;
}

/* ============================================================
 * 7. 脚本资产加载分支（T3.3：.ts → 同一 IR；.py → 提示）
 * ============================================================ */

/** POST /api/transpile 诊断（server/transpile.ts 契约；行列 1 起） */
interface TranspileDiag {
  line: number;
  column: number;
  message: string;
}

/** POST /api/transpile 响应体（ok=false 时 errors / message 之一可用） */
interface TranspileResponse {
  ok?: boolean;
  js?: unknown;
  warnings?: TranspileDiag[];
  errors?: TranspileDiag[];
  message?: string;
}

/** 绑定路径的逻辑资产种类（按扩展名判定；大小写不敏感） */
type AssetKind = 'blueprint' | 'script-ts' | 'script-py';

function assetKindOf(path: string): AssetKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.ts')) return 'script-ts';
  if (lower.endsWith('.py')) return 'script-py';
  return 'blueprint'; // 默认按 .bp.json 处理（含其它扩展的容错回落，与 T2.6 行为一致）
}

/** 控制台 print 前缀里的资产种类名（蓝图 / 脚本） */
const KIND_LABEL: Record<AssetKind, string> = {
  blueprint: '蓝图',
  'script-ts': '脚本',
  'script-py': '脚本',
};

/**
 * 绑定运行器：发现绑定 → 按扩展名加载（.bp.json → deserializeIR；.ts → 服务端转译 +
 * parseScriptToIR，T3.3；.py → T4.1 提示）→ 逐资产建 runtime（UiHandle / hub / print /
 * vars）→ start()；routeEvent 把 renderUI 的内建事件路由给持有该节点的 runtime。
 */
export class BindingRunner {
  private readonly opts: Required<Pick<BindingRunnerOptions, 'project' | 'asset' | 'renderHandle'>> &
    BindingRunnerOptions;
  /** 事件总线（T5.1）：loadAndStart 时确定（opts.bus 注入或自建）；环保护警告走 print 通道 */
  private bus: EventBus | null = null;
  private readonly entries: RuntimeEntry[] = [];
  private seq = 0;
  private stopped = false;

  constructor(opts: BindingRunnerOptions) {
    this.opts = { fetchImpl: undefined, onPrint: undefined, onError: undefined, ...opts };
  }

  /** 是否已加载过（loadAndStart 只应成功执行一次；重复调用静默返回） */
  private loaded = false;

  private print(line: string): void {
    this.opts.onPrint?.(line);
  }

  /** GET /api/file（与 RuntimeApp 同契约）；失败抛中文错误 */
  private async fetchFileText(path: string): Promise<string> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl(`/api/file?path=${encodeURIComponent(path)}`);
    const body = (await res.json().catch(() => null)) as { ok?: boolean; content?: unknown; message?: string } | null;
    if (!body || body.ok !== true) {
      throw new Error(body?.message ?? `HTTP ${res.status}`);
    }
    return String(body.content ?? '');
  }

  /**
   * POST /api/transpile（T3.3：运行窗口走服务端转译，PLAN §9.2）。
   * 返回响应体；网络 / 响应形状异常抛中文错误（与 fetchFileText 同风格）。
   */
  private async requestTranspile(path: string, content: string): Promise<TranspileResponse> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const res = await fetchImpl('/api/transpile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, content }),
    });
    const body = (await res.json().catch(() => null)) as TranspileResponse | null;
    if (!body || typeof body.ok !== 'boolean') {
      throw new Error(`转译服务响应异常（HTTP ${res.status}）`);
    }
    return body;
  }

  /**
   * .ts 资产 → IRAsset（T3.3 · D3 单一 IR 路径）：
   *  1) 服务端转译：语法级错误 → 抛错（外层 catch print + onError + 跳过该资产）；
   *     警告 → print 提示但继续。转译产物本身不用于执行（留给将来直接执行模式与诊断）。
   *  2) parseScriptToIR(源码)：受控子集 → 同一 IRAsset，与蓝图共用 createRuntime 路径；
   *     解析诊断 error 级 → 抛错跳过；warning 级 → print 提示继续。
   */
  private async loadScriptIR(path: string, source: string): Promise<IRAsset> {
    const tr = await this.requestTranspile(path, source);
    if (!tr.ok) {
      const detail = (tr.errors ?? []).map((e) => `第 ${e.line} 行第 ${e.column} 列：${e.message}`).join('；');
      throw new Error(`TS 转译失败：${detail || tr.message || '未知错误'}`);
    }
    for (const w of tr.warnings ?? []) {
      this.print(`[转译] ${path} 警告（第 ${w.line} 行第 ${w.column} 列）：${w.message}`);
    }
    // 动态 import：TS 编译器体量大，仅当确有 .ts 绑定才载入解析器（vite 按需分包）
    const { parseScriptToIR } = await import('@/script/parser-ts');
    const parsed = parseScriptToIR(source);
    const errors = parsed.diagnostics.filter((d) => d.severity === 'error');
    const warnings = parsed.diagnostics.filter((d) => d.severity === 'warning');
    for (const w of warnings) {
      this.print(`[脚本] ${path} 警告（第 ${w.line} 行第 ${w.column} 列）：${w.message}`);
    }
    if (errors.length > 0) {
      const detail = errors.map((e) => `第 ${e.line} 行第 ${e.column} 列：${e.message}`).join('；');
      throw new Error(`脚本解析错误（${errors.length} 处）：${detail}`);
    }
    return parsed.asset;
  }

  /**
   * 加载全部绑定蓝图并启动（DoD ②）：
   * 每个唯一 logicAsset 路径一个 runtime 实例；节点事件只发给持有它的 runtime。
   * 单个蓝图加载失败只打印错误，不影响其它绑定与 UI 渲染。
   */
  async loadAndStart(): Promise<void> {
    if (this.loaded || this.stopped) return;
    this.loaded = true;
    // 事件总线（T5.1）：可注入共享实例（跨 UI 实例广播）；环保护警告 → 控制台 print
    const bus = this.opts.bus ?? (this.bus = createEventBus({ onWarn: (m) => this.print(m) }));
    const bindings = collectBoundNodes(this.opts.asset);
    const specs = editorSpecMap();
    for (const binding of bindings) {
      if (this.stopped) return;
      const kind = assetKindOf(binding.path);
      if (kind === 'script-py') {
        // Python 运行时本期未接入（T4.1 Pyodide）：只提示、不报错不崩溃，UI 渲染不受影响
        this.print(`[绑定] 暂不执行 ${binding.path}：Python 运行时将在 T4.1（Pyodide 集成）接入`);
        continue;
      }
      const tag = `bp${this.seq++}`;
      try {
        const text = await this.fetchFileText(`${this.opts.project}/${binding.path}`);
        const ir =
          kind === 'script-ts' ? await this.loadScriptIR(binding.path, text) : deserializeIR(text);
        if (this.stopped) return;
        // 片段运行时（T3.7 / ADR-007）：按资产注入 script.snippet spec 并重写纯片段节点类型
        const { asset: irWithSnippets, specs: assetSpecs } = injectSnippetRuntime(ir, specs);
        const kindLabel = KIND_LABEL[kind];
        const nameSet = collectNames(binding.nodes);
        const ui = makeUiHandle({
          scopes: binding.nodes,
          getEl: (node) => this.opts.renderHandle.el.querySelector<HTMLElement>(`[data-uid="${node.id}"]`),
          refresh: () => updateUI(this.opts.renderHandle, this.opts.asset),
          onMissing: (message) => this.print(`[${kindLabel}:${ir.name}] ${message}`),
        });
        const rt = createRuntime(irWithSnippets, assetSpecs, {
          ui,
          onPrint: (...parts) => this.print(`[${kindLabel}:${ir.name}] ${parts.map((p) => strOf(p)).join(' ')}`),
          onError: (err, graphName, nodeId) => {
            const where = nodeId ? `（图 ${graphName} · 节点 ${nodeId}）` : `（图 ${graphName}）`;
            this.print(`[错误] ${kindLabel} ${ir.name}${where}：${err.message}`);
            this.opts.onError?.(err.message);
          },
          // 自定义事件 → 总线回灌（零侵入 T2.6 模式）：总线按 target 路由到其它实例；
          // T5.4：注入 debugProbe 时同一回调追加推入观察通道（独立小函数，不碰加载分支）
          onDebug: composeDebugSink(runtimeEventSink(tag, bus), this.opts.debugProbe, binding.path),
          vars: varsFromIR(ir),
        });
        bus.register({
          id: tag,
          assetPath: binding.path,
          uiId: this.opts.uiId,
          boundNodes: nameSet,
          rt,
        });
        this.entries.push({ tag, path: binding.path, ir: irWithSnippets, rt, nameSet, kindLabel });
        this.print(
          `[绑定] 已加载 ${binding.path}（${kindLabel}「${ir.name}」；绑定节点：${binding.nodes.map((n) => n.name).join('、')}）`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.print(`[绑定] 加载失败：${binding.path} —— ${message}`);
        this.opts.onError?.(`逻辑资产加载失败：${binding.path} —— ${message}`);
      }
    }
    if (this.stopped) return;
    for (const entry of this.entries) {
      try {
        entry.rt.start(); // 触发各蓝图的 event.start（BeginPlay 同义；脚本资产同语义）
      } catch (err) {
        this.print(`[错误] ${entry.kindLabel} ${entry.ir.name} 启动失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /**
   * 事件路由（renderUI onEvent → 这里）：经事件总线（T5.1）投递——target='node'，
   * 只达绑定该节点名的 runtime（payload 统一包 { value }，总线 routeEvent 完成）。
   * 未加载 / 节点不属于任何绑定子树 → 静默丢弃（未启动 rt.emit 也按解释器语义丢弃）。
   */
  routeEvent(evt: UIRenderEvent): void {
    this.bus?.routeEvent(evt);
  }

  /** 停止全部 runtime（窗口关闭 / 刷新 / 重载时调用；幂等）。 */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const entry of this.entries) {
      this.bus?.unregister(entry.tag); // 总线注销：后续事件不再投递
      entry.rt.stop(); // 解释器 stop：清队 + abort signal + 复位状态槽
    }
  }
}
