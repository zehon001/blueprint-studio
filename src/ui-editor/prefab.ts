/**
 * UI 预制体核心（T7.3 · ADR-009 · PLAN §7.4）
 *
 * 契约真源：src/ir/types.ts 的 UINode.prefab（可选，项目内相对路径，如
 * 'ui/prefabs/list-item.ui.json'）；语义全量裁定见 docs/v2/adr/009-ui-prefab.md。
 *
 * 本模块两层职责，均不依赖 React / store（node:test 可直接单测）：
 *  1. 纯逻辑（可测真源）：
 *     - collectPrefabPaths：扫描树内全部 prefab 路径（预取清单）；
 *     - expandPrefabNode：实例节点 → 展开后的有效节点（ADR-009 合并语义 + 循环/深度检测，
 *       未命中缓存返回占位节点——渲染器唯一的 prefab 消费入口）；
 *     - findPrefabCycle：全树循环引用校验（运行窗口装载期用，中文错误）；
 *     - toPrefabRoot / materializePrefabNode：保存为预制体（导出根）与断开预制体（物化）；
 *  2. 同步渲染 × 异步资源的接合（ADR-009 §4）：
 *     - 模块级缓存 Map<路径, UIAsset> + in-flight 去重 + 失败集合；
 *     - 装载方（编辑器 store openUIAsset / 运行窗口 RuntimeApp.load）经
 *       setPrefabLoaderContext 注入项目上下文，装载前 clearPrefabCache + prefetchPrefabs
 *       ——「每次打开/刷新重新拉取」即预制体改动反射到引用处的机制；
 *     - 渲染器缓存未命中时 ensurePrefabLoaded 补拉，成功经返回值通知调用方刷新
 *       （失败不再重试，占位显示中文错误；重试只能经 clearPrefabCache —— 打开/刷新）。
 */
import type { UIAsset, UINode } from '../ir/types'
import { stripDefaultProps } from './styles'
import { prefixSubtreeIds } from './scopedIds'

/* ============================================================
 * 常量与路径工具
 * ============================================================ */

/** 预制体嵌套展开深度上限（超深视为疑似循环，防御性兜底；ADR-009 §3） */
export const PREFAB_MAX_DEPTH = 16

/** 新建预制体的约定目录（项目内相对路径；ADR-009 §5） */
export const PREFAB_DIR = 'ui/prefabs'

/** 预制体占位节点的 type 标记（渲染器按它分发占位渲染器；不入 schema、不入资产） */
export const PREFAB_PLACEHOLDER_TYPE = '__prefab_placeholder'

/** 占位节点展示文本存放在 props 的键（占位节点为渲染期派生对象，不落资产） */
export const PREFAB_PLACEHOLDER_TEXT = '__placeholder'

/**
 * 预制体路径 → 显示名（文件主干）：'ui/prefabs/list-item.ui.json' → 'list-item'。
 * 树面板徽标 / tab 标题 / 检视器摘要共用。
 */
export function prefabLabelOf(path: string): string {
  const norm = path.replace(/\\/g, '/')
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  return base.replace(/\.ui\.json$/i, '') || base
}

/* ============================================================
 * 1. 纯逻辑：路径收集
 * ============================================================ */

/** 收集树内全部 prefab 路径（按出现顺序去重；不展开进已引用的预制体——深取用 prefetchPrefabs） */
export function collectPrefabPaths(root: UINode, out: string[] = []): string[] {
  const seen = new Set(out)
  const walk = (node: UINode): void => {
    if (typeof node.prefab === 'string' && node.prefab.trim() !== '' && !seen.has(node.prefab)) {
      seen.add(node.prefab)
      out.push(node.prefab)
    }
    for (const c of node.children) walk(c)
  }
  walk(root)
  return out
}

/* ============================================================
 * 2. 纯逻辑：展开（合并语义 + 循环/深度检测）
 * ============================================================ */

/** 展开结果：node 恒存在（受限时为占位节点）；error 非空给出中文原因；missing 标记「因未加载而起」 */
export interface PrefabExpand {
  /** 展开后的有效节点（渲染/展示消费；不写回资产） */
  node: UINode
  /** 展开受限原因（循环引用 / 超深 / 预制体未加载；null = 正常展开或普通节点） */
  error: string | null
  /** error 是否因「预制体未加载」而起（渲染器据此安排异步补拉） */
  missing: boolean
}

/** 预制体解析器：路径 → 已缓存的预制体资产（未命中返回 null；渲染器传getCachedPrefab） */
export type PrefabResolver = (path: string) => UIAsset | null

/**
 * 已展开节点标记（WeakSet，对象身份级）：expandPrefabNode 的产物（合并节点 / 占位节点）
 * 会被渲染 reconcile 逐层重新过目，若不标记，「展开结果的子节点仍带 prefab 字段」会被
 * 再次展开（且链式循环检测的 chain 每次从空开始）——循环引用场景因此无限递归。展开产物
 * 恒为新建对象、永不回写资产，标记无副作用；输入侧资产节点永不被标记（可重复展开）。
 */
const expandedNodes = new WeakSet<UINode>()

/** 节点是否为 expandPrefabNode 的产物（渲染器 effectiveNode 据此跳过二次展开） */
export function isPrefabExpanded(node: UINode): boolean {
  return expandedNodes.has(node)
}

/** 构造占位节点（保留实例 id/name/transform，结构标记为占位类型，展示中文原因） */
function placeholderNode(instance: UINode, text: string): UINode {
  const node: UINode = {
    id: instance.id,
    name: instance.name,
    type: PREFAB_PLACEHOLDER_TYPE,
    transform: instance.transform,
    theme: {},
    props: { [PREFAB_PLACEHOLDER_TEXT]: text },
    events: [],
    children: [],
    prefab: instance.prefab,
  };
  expandedNodes.add(node);
  return node;
}

/** 实例事件/逻辑绑定是否「已声明」（空数组/空串视为未声明，回落预制体根的默认绑定） */
function instanceBindingDeclared(v: string[] | string | undefined): boolean {
  if (v === undefined) return false;
  return typeof v === 'string' ? v.trim() !== '' : v.length > 0;
}

/**
 * 实例节点 → 展开后的有效节点（ADR-009 §2 合并语义，递归）。
 * - 非 prefab 节点原样返回（恒等，零开销）；
 * - 合并：id/name/transform 保留实例自身值；type 取预制体根；props/theme 实例浅覆盖预制体根；
 *   children 取预制体根子树（实例自身 children 忽略），子树内嵌套实例递归展开；
 * - events/logicAsset 实例已声明用实例值，否则回落预制体根（空数组/空串视为未声明）；
 * - 循环检测：chain 为当前展开链上的预制体路径（长度 = 预制体跳数），重复即报中文错误；
 *   跳数超 PREFAB_MAX_DEPTH 报错（深度上限只计预制体嵌套，不限制普通子树深度）；
 * - 预制体未加载（resolver 返回 null）：占位节点 + missing=true（渲染器补拉后刷新）。
 */
export function expandPrefabNode(
  instance: UINode,
  resolver: PrefabResolver,
  chain: readonly string[] = [],
): PrefabExpand {
  if (!instance.prefab) return { node: instance, error: null, missing: false };
  const path = instance.prefab;
  if (chain.includes(path)) {
    const loop = [...chain.slice(chain.indexOf(path)), path].join(' → ')
    return {
      node: placeholderNode(instance, `检测到预制体循环引用：${loop}`),
      error: `检测到预制体循环引用：${loop}`,
      missing: false,
    };
  }
  if (chain.length >= PREFAB_MAX_DEPTH) {
    const msg = `预制体嵌套超过最大深度（${PREFAB_MAX_DEPTH}）：${[...chain, path].join(' → ')}`
    return { node: placeholderNode(instance, msg), error: msg, missing: false };
  }
  const asset = resolver(path);
  if (!asset) {
    const reason = getPrefabFailure(path);
    return {
      node: placeholderNode(instance, reason ? `${reason}（${path}）` : `预制体加载中…（${path}）`),
      error: reason ?? `预制体未加载：${path}`,
      missing: !reason,
    };
  }
  const prefabRoot = asset.root;
  const nextChain = [...chain, path];
  const node: UINode = {
    id: instance.id,
    name: instance.name,
    type: prefabRoot.type,
    transform: instance.transform ?? prefabRoot.transform,
    // v3：实例保留自身布局覆盖（位置/尺寸），容器语义取预制体根
    ...(instance.layout ?? prefabRoot.layout ? { layout: instance.layout ?? prefabRoot.layout } : {}),
    ...(prefabRoot.container ? { container: prefabRoot.container } : {}),
    ...(instance.classes ?? prefabRoot.classes ? { classes: instance.classes ?? prefabRoot.classes } : {}),
    // 浅覆盖（ADR-009 §2）：实例 props 里的键写实例值，其余回落预制体根
    theme: { ...prefabRoot.theme, ...instance.theme },
    props: { ...prefabRoot.props, ...instance.props },
    events: instanceBindingDeclared(instance.events) ? instance.events : prefabRoot.events,
    logicAsset: instanceBindingDeclared(instance.logicAsset) ? instance.logicAsset : prefabRoot.logicAsset,
    prefab: instance.prefab,
    children: [],
  };
  let childError: string | null = null;
  node.children = prefabRoot.children.map((c) => {
    const r = expandPrefabNode(c, resolver, nextChain);
    if (r.error && !childError) childError = r.error;
    // 实例内部 id 作用域化（多实例/事件路由唯一）
    prefixSubtreeIds(r.node, instance.id);
    return r.node;
  });
  expandedNodes.add(node); // 展开产物标记：reconcile 下层经 isPrefabExpanded 跳过二次展开
  // 子树内嵌套实例受限时同样向上报告（外层渲染正常，占位出现在出错的内层节点）
  return { node, error: childError, missing: false };
}

/**
 * 全树循环引用校验（装载期用，如运行窗口 load）：命中返回中文错误（首个），否则 null。
 * 与 expandPrefabNode 同一套链式规则、同语义（实例自身 children 被忽略，只沿
 * 「实例 → 预制体根 children」走；预制体根自身的 prefab 字段不参与展开——根级继承未定义）。
 */
export function findPrefabCycle(root: UINode, resolver: PrefabResolver): string | null {
  const walk = (node: UINode, chain: readonly string[]): string | null => {
    if (!node.prefab) {
      for (const c of node.children) {
        const hit = walk(c, chain)
        if (hit) return hit
      }
      return null
    }
    const path = node.prefab
    if (chain.includes(path)) {
      const loop = [...chain.slice(chain.indexOf(path)), path].join(' → ')
      return `检测到预制体循环引用：${loop}`
    }
    if (chain.length >= PREFAB_MAX_DEPTH) {
      return `预制体嵌套超过最大深度（${PREFAB_MAX_DEPTH}）：${[...chain, path].join(' → ')}`
    }
    const asset = resolver(path)
    if (!asset) return null // 未加载：展开期只会占位，无循环可循
    for (const c of asset.root.children) {
      const hit = walk(c, [...chain, path])
      if (hit) return hit
    }
    return null
  }
  return walk(root, [])
}

/* ============================================================
 * 3. 纯逻辑：导出（保存为预制体）与物化（断开预制体）
 * ============================================================ */

/**
 * 节点子树 → 预制体根（「保存为预制体」导出用）：
 * 深拷贝（与源节点完全独立）；events / logicAsset 属实例装配，不写入预制体定义（ADR-009 §5）。
 */
export function toPrefabRoot(node: UINode): UINode {
  const clone = JSON.parse(JSON.stringify(node)) as UINode;
  const strip = (n: UINode): void => {
    delete n.events;
    delete n.logicAsset;
    for (const c of n.children) strip(c);
  };
  strip(clone);
  return clone;
}

/**
 * 断开预制体（物化）：以「当前有效节点」冻结实例——
 * - type 取预制体根（实例 type 快照可能与预制体漂移，物化以实际渲染结构为准）；
 * - props/theme = 预制体根 ∪ 实例覆盖（外观不变）；
 * - children = 预制体根子树深拷贝，全新 id（freshId）+ 树内唯一名（对 taken 去重并写入）；
 *   子树内嵌套实例保留其自身 prefab 引用（嵌套实例是独立实例，不随外层物化）；
 * - name/transform/events/logicAsset 保留实例自身值；返回的新节点**不带 prefab 字段**。
 * 纯函数：不修改任何入参（taken 只读，大小写不敏感去重，命令层可安全重放）。
 */
export function materializePrefabNode(
  instance: UINode,
  prefabRoot: UINode,
  taken: Set<string>,
  freshId: () => string,
): UINode {
  // 子树克隆：全新 id + name 去重（" (n)" 后缀，与树面板 cloneSubtree 同款）
  const clone = JSON.parse(JSON.stringify({ ...prefabRoot, id: 'materialize_root', name: instance.name })) as UINode;
  // 小写占用表（大小写不敏感去重；入参 taken 可含原大小写名，内部统一小写比较）
  const lowerTaken = new Set<string>([...taken].map((n) => n.toLowerCase()));
  const walk = (n: UINode): void => {
    n.id = freshId();
    if (lowerTaken.has(n.name.toLowerCase())) {
      for (let i = 2; ; i++) {
        const cand = `${n.name} (${i})`;
        if (!lowerTaken.has(cand.toLowerCase())) {
          n.name = cand;
          break;
        }
      }
    }
    lowerTaken.add(n.name.toLowerCase());
    for (const c of n.children) walk(c);
  };
  const children = clone.children.map((c) => {
    walk(c);
    return c;
  });
  return {
    id: instance.id,
    name: instance.name,
    type: prefabRoot.type,
    transform: instance.transform,
    ...(instance.layout ?? prefabRoot.layout ? { layout: instance.layout ?? prefabRoot.layout } : {}),
    ...(prefabRoot.container ? { container: prefabRoot.container } : {}),
    ...(instance.classes ?? prefabRoot.classes ? { classes: instance.classes ?? prefabRoot.classes } : {}),
    theme: { ...prefabRoot.theme, ...instance.theme },
    props: { ...prefabRoot.props, ...instance.props },
    // 与展开同规则：实例已声明用实例值，否则冻结预制体根的默认绑定
    events: instanceBindingDeclared(instance.events) ? instance.events : prefabRoot.events,
    logicAsset: instanceBindingDeclared(instance.logicAsset) ? instance.logicAsset : prefabRoot.logicAsset,
    children,
  };
}

/* ============================================================
 * 4. 缓存与预取（同步渲染 × 异步资源的接合）
 * ============================================================ */

/** 装载方注入的取文件上下文（编辑器 store / 运行窗口 load 各自设置） */
export interface PrefabLoaderContext {
  /** 项目内相对路径前缀（GET /api/file?path=<projectPath>/<prefabPath>） */
  projectPath: string
  /** fetch 替身（测试注入；缺省全局 fetch） */
  fetchImpl?: typeof fetch
}

/** 路径 → 预制体资产缓存（渲染器同步查表；装载方预取写入） */
const cache = new Map<string, UIAsset>()
/** in-flight 去重（同路径并发请求合并为一次） */
const inflight = new Map<string, Promise<UIAsset | null>>()
/** 拉取失败集合：渲染路径不再重试（避免「占位→刷新→再失败」循环）；clearPrefabCache 重置 */
const failed = new Set<string>()
const failureMessages = new Map<string, string>()

let loaderContext: PrefabLoaderContext | null = null

/** 注入取文件上下文（编辑器 openUIAsset / 运行窗口 load 调用；null 清除） */
export function setPrefabLoaderContext(ctx: PrefabLoaderContext | null): void {
  loaderContext = ctx
}

/** 清空缓存 / in-flight / 失败集合（每次打开资产或运行刷新时调用 = 反射机制的一部分） */
export function clearPrefabCache(): void {
  cache.clear()
  inflight.clear()
  failed.clear()
  failureMessages.clear()
}

/** 预制体加载失败原因（版本不兼容等；未知返回 undefined） */
export function getPrefabFailure(path: string): string | undefined {
  return failureMessages.get(path)
}

/** 读缓存（同步；未命中 null） */
export function getCachedPrefab(path: string): UIAsset | null {
  return cache.get(path) ?? null
}

/** 直接写入缓存（「保存为预制体」时本地内容立即可用，无需回读） */
export function primePrefabCache(path: string, asset: UIAsset): void {
  cache.set(path, asset)
  failed.delete(path)
}

/** 缓存未命中且未在失败集合中（渲染器据此决定是否补拉） */
export function prefabNeedsLoad(path: string): boolean {
  return !cache.has(path) && !failed.has(path)
}

/** 单个预制体拉取（GET /api/file；解析失败/缺失文件 resolve null，不 reject） */
async function fetchPrefabAsset(path: string): Promise<UIAsset | null> {
  const ctx = loaderContext;
  if (!ctx) return null;
  const doFetch = ctx.fetchImpl ?? fetch;
  try {
    const r = await doFetch(`/api/file?path=${encodeURIComponent(`${ctx.projectPath}/${path}`)}`);
    const json = (await r.json()) as { ok?: boolean; content?: string; message?: string };
    if (!json.ok || typeof json.content !== 'string') return null;
    const raw = JSON.parse(json.content) as Partial<UIAsset>;
    // v3 门禁（T13.2）：预制体资产同样只接受 version 3
    if (!raw || raw.version !== 3 || !raw.root) {
      failureMessages.set(
        path,
        raw && raw.version !== 3
          ? `预制体版本不兼容：${String(raw.version)}（v3 仅支持 version 3）`
          : '预制体资产缺少 root',
      )
      return null;
    }
    // v3 T11.1：去掉物化的默认 props（样式类优先）
    return { ...(raw as UIAsset), root: stripDefaultProps(raw.root as UINode) };
  } catch {
    return null;
  }
}

/**
 * 确保预制体已加载（渲染路径兜底 + 预取共用）：
 * 返回 'cached'（已有缓存）/ 'loaded'（本次调用发起或接力了加载且成功）/ 'error'（失败，
 * 此后不再重试直至 clearPrefabCache）。渲染器只在 'loaded' 时刷新占位（无刷新循环）。
 */
export async function ensurePrefabLoaded(path: string): Promise<'cached' | 'loaded' | 'error'> {
  if (cache.has(path)) return 'cached';
  if (failed.has(path)) return 'error';
  let p = inflight.get(path);
  if (!p) {
    p = fetchPrefabAsset(path).then((asset) => {
      if (asset) cache.set(path, asset);
      else failed.add(path);
      inflight.delete(path);
      return asset;
    });
    inflight.set(path, p);
  }
  const asset = await p;
  return asset ? 'loaded' : 'error';
}

/**
 * 预取树内全部预制体（BFS：资产树内路径 + 已取到预制体树内的嵌套路径）；
 * 全部并行，失败静默（占位兜底）。返回涉及的全部路径（去重）。
 */
export async function prefetchPrefabs(root: UINode): Promise<string[]> {
  const seen = new Set<string>();
  let frontier = collectPrefabPaths(root);
  while (frontier.length > 0) {
    const next: string[] = [];
    await Promise.all(
      frontier.map(async (p) => {
        if (seen.has(p)) return;
        seen.add(p);
        await ensurePrefabLoaded(p);
        const asset = getCachedPrefab(p);
        if (asset) {
          for (const nested of collectPrefabPaths(asset.root)) {
            if (!seen.has(nested)) next.push(nested);
          }
        }
      }),
    );
    frontier = next;
  }
  return [...seen];
}
