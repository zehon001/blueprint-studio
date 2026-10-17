/**
 * Blueprint Studio v2 —— TA.1 roundtrip 样本注册表（DoD：一节点一样本 + 场景样本）
 *
 * 职责：
 *  1. `roundtripSamples`：全部 roundtrip 样本的注册表（数组，{ name, kind, build() }），
 *     覆盖 ① builtinSpecs 逐节点样本（52 纯节点 + 17 可往返执行节点）、② 场景样本
 *     （全特性 / 条件循环 / 日志管线 / 字符串链）、③ 片段节点专项样本（T3.7）、
 *     ④ 真实资产样本（templates/log-analyzer，含片段演化）。
 *  2. `KNOWN_UNMAPPED_NODE_IDS`：「已知无法往返清单」（8 项，见该常量注释）——
 *     门禁对清单内节点显式跳过（而非静默漏测）。
 *  3. `auditCoverage`：覆盖审计（计数守卫）——builtinSpecs 总数 = 已测数 + 已知跳过数，
 *     「既无样本又未登记跳过」的节点记入 missing（门禁红灯依据）。
 *
 * ★ 新节点入库流程（两步，详见 README.md）：
 *    步骤一：样本构造进本文件——纯节点无需动作（`pureNodeSample` 自动覆盖）；
 *            执行节点在 `execNodeSampleDefs` 加一条最小图构造器；
 *    步骤二：若该执行节点当前无法往返（codegen 抛「暂无脚本映射」，或已知往返缺口），
 *            同步把 id 登记进 `KNOWN_UNMAPPED_NODE_IDS` 并注明原因。
 *    两步都不做 → `auditCoverage` 判 missing → 门禁测试红灯。
 *
 * 样本约定（与基座 pureNodeSample 一致）：不显式写入「等于 spec 默认值」的引脚值
 * （往返后归一为缺省，语义不变）；build() 每次返回可用的新资产（roundtripIR 不改输入，
 * 场景样本复用基座常量属共享只读）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IRAsset, NodeSpec } from '../../src/ir/types';
import { builtinSpecs, builtinSpecMap } from '../../src/nodes';
import { deserializeIR } from '../../src/ir/validate';
import {
  asset,
  node,
  graph,
  execEdge,
  dataEdge,
  pureNodeSample,
  counterAsset,
  logPipelineAsset,
  stringChainAsset,
  multiSnippetAsset,
  fullFeatureAsset,
} from './roundtrip-helpers';

/* ============================================================
 * 已知无映射清单（显式跳过；codegen 对这些执行节点抛「暂无脚本映射」）
 * ============================================================ */

/**
 * 已知无法往返清单（显式跳过；门禁对它们显式跳过而非静默漏测）：
 * codegen 明确抛「暂无脚本映射」的执行节点（emitNodeStatement → CodegenError）：
 *  - 流程状态机类（单次 run 单出口契约下采用「链尾回连」状态机，无线性语句形态）：
 *    flow.gate / flow.flipFlop / flow.doOnce / flow.multiGate / event.timer；
 *  - 解释器钩子类（运行时经 ctx 钩子执行，脚本视图暂无对应全局函数）：
 *    system.notify / system.clipboardWrite / system.openUrl。
 *
 * （原【二】「往返缺口」类——codegen 已映射、parser 无法还原的 flow.sequence /
 * ui.setTitle，经 parser-ts.ts 修复标记扫描正则与 ui 写值属性反查后已可往返，
 * 移回样本库 execNodeSampleDefs；后续再出现同类缺口仍按维护规则登记于此。）
 *
 * 维护规则：节点删除时同步清条目（auditCoverage.stale 会红灯提醒）；新增无法往返的
 * 执行节点必须登记于此（否则门禁红）；缺口修复后从清单移除并补样本（samples.ts）。
 */
export const KNOWN_UNMAPPED_NODE_IDS: ReadonlySet<string> = new Set([
  // ——暂无脚本映射（codegen 抛错）——
  'flow.gate',
  'flow.flipFlop',
  'flow.doOnce',
  'flow.multiGate',
  'event.timer',
  'system.notify',
  'system.clipboardWrite',
  'system.openUrl',
]);

/* ============================================================
 * 执行节点样本（每个可映射执行节点一个最小图；T3.5 已覆盖 52 纯节点，此处补齐执行侧）
 * ============================================================ */

/** system.readFile：读项目文件文本（路径字面量 → text 出脚被引用） */
function execSystemReadFile(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('rd', 'system.readFile', { pinDefaults: { path: 'assets/sample.log' } }),
        node('pr', 'system.print'),
      ],
      [execEdge('x1', 'st', 'rd'), execEdge('x2', 'rd', 'pr'), dataEdge('d1', 'rd', 'text', 'pr', 'value')],
    ),
  });
}

/** event.start：start 事件入口 → 打印 */
function execEventStart(): IRAsset {
  return asset({
    main: graph(
      [node('st', 'event.start'), node('pr', 'system.print', { pinDefaults: { value: '启动' } })],
      [execEdge('x1', 'st', 'pr')],
    ),
  });
}

/** event.custom：自定义事件入口（事件表定义参数 count，输出脚被引用 → 方法参数） */
function execEventCustom(): IRAsset {
  return asset(
    {
      main: graph(
        [node('evt', 'event.custom', { params: { eventName: 'loaded' } }), node('pr', 'system.print')],
        [execEdge('x1', 'evt', 'pr'), dataEdge('d1', 'evt', 'count', 'pr', 'value')],
      ),
    },
    { events: [{ name: 'loaded', params: [{ name: 'count', type: 'int' }] }] },
  );
}

/** event.send：发送事件（eventName 内联默认值；无 args 实参 → emit 单参形态） */
function execEventSend(): IRAsset {
  return asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('send', 'event.send', { pinDefaults: { eventName: 'ping' } }),
          node('pr', 'system.print', { pinDefaults: { value: '已发送' } }),
        ],
        [execEdge('x1', 'st', 'send'), execEdge('x2', 'send', 'pr')],
      ),
    },
    { events: [{ name: 'ping', params: [] }] },
  );
}

/** event.listen：监听事件（args 输出脚被引用 → onEvent 方法参数注入） */
function execEventListen(): IRAsset {
  return asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('pr1', 'system.print', { pinDefaults: { value: '等待' } }),
          node('lst', 'event.listen', { pinDefaults: { eventName: 'tick' } }),
          node('pr2', 'system.print'),
        ],
        [execEdge('x1', 'st', 'pr1'), execEdge('x2', 'lst', 'pr2'), dataEdge('d1', 'lst', 'args', 'pr2', 'value')],
      ),
    },
    { events: [{ name: 'tick', params: [] }] },
  );
}

/** flow.branch：分支两臂各自终止（if/else 空汇合形态） */
function execFlowBranch(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('br', 'flow.branch', { pinDefaults: { cond: true } }),
        node('prT', 'system.print', { pinDefaults: { value: '真' } }),
        node('prF', 'system.print', { pinDefaults: { value: '假' } }),
      ],
      [execEdge('x1', 'st', 'br'), execEdge('x2', 'br', 'prT', 'true'), execEdge('x3', 'br', 'prF', 'false')],
    ),
  });
}

/** flow.sequence：序列状态机（out0..out3 各接一条 print 子链；out0..out2 链尾连回
 * exec 入——续接触发语义，经 __bps-seq 标记重建：同 id 首现建节点、链尾标记回连） */
function execFlowSequence(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('sq', 'flow.sequence'),
        node('pr0', 'system.print', { pinDefaults: { value: 's0' } }),
        node('pr1', 'system.print', { pinDefaults: { value: 's1' } }),
        node('pr2', 'system.print', { pinDefaults: { value: 's2' } }),
        node('pr3', 'system.print', { pinDefaults: { value: 's3' } }),
      ],
      [
        execEdge('x1', 'st', 'sq'),
        execEdge('x2', 'sq', 'pr0', 'out0'),
        execEdge('x3', 'pr0', 'sq'),
        execEdge('x4', 'sq', 'pr1', 'out1'),
        execEdge('x5', 'pr1', 'sq'),
        execEdge('x6', 'sq', 'pr2', 'out2'),
        execEdge('x7', 'pr2', 'sq'),
        execEdge('x8', 'sq', 'pr3', 'out3'),
      ],
    ),
  });
}

/** flow.forLoop：计数循环（体尾回连；index 输出被体引用；done 走完成链） */
function execFlowForLoop(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('loop', 'flow.forLoop', { pinDefaults: { to: 2 } }),
        node('prB', 'system.print'),
        node('prD', 'system.print', { pinDefaults: { value: '完成' } }),
      ],
      [
        execEdge('x1', 'st', 'loop'),
        execEdge('x2', 'loop', 'prB', 'body'),
        execEdge('x2b', 'prB', 'loop'),
        execEdge('x3', 'loop', 'prD', 'done'),
        dataEdge('d1', 'loop', 'index', 'prB', 'value'),
      ],
    ),
  });
}

/** flow.whileLoop：条件循环（条件接变量；体尾回连；done 走完成链） */
function execFlowWhileLoop(): IRAsset {
  return asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('flagGet', 'var.get', { params: { varName: 'running' } }),
          node('wh', 'flow.whileLoop'),
          node('prB', 'system.print', { pinDefaults: { value: '心跳' } }),
          node('prD', 'system.print', { pinDefaults: { value: '结束' } }),
        ],
        [
          execEdge('x1', 'st', 'wh'),
          execEdge('x2', 'wh', 'prB', 'body'),
          execEdge('x2b', 'prB', 'wh'),
          execEdge('x3', 'wh', 'prD', 'done'),
          dataEdge('d1', 'flagGet', 'value', 'wh', 'cond'),
        ],
      ),
    },
    { variables: [{ name: 'running', type: 'bool', default: true }] },
  );
}

/** flow.delay：延时（字面量秒 → await delay(毫秒)，方法体转 async；done 出脚续链） */
function execFlowDelay(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('dl', 'flow.delay', { pinDefaults: { seconds: 0.2 } }),
        node('pr', 'system.print', { pinDefaults: { value: '醒' } }),
      ],
      [execEdge('x1', 'st', 'dl'), execEdge('x2', 'dl', 'pr', 'done')],
    ),
  });
}

/** array.forEach：数组遍历（body 回连 + element 输出 + done 完成） */
function execArrayForEach(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('mk', 'array.make', { pinDefaults: { in0: 'a', in1: 'b' } }),
        node('fe', 'array.forEach'),
        node('prB', 'system.print'),
        node('prD', 'system.print', { pinDefaults: { value: '遍历完' } }),
      ],
      [
        execEdge('x1', 'st', 'fe'),
        execEdge('x2', 'fe', 'prB', 'body'),
        execEdge('x2b', 'prB', 'fe'),
        execEdge('x3', 'fe', 'prD', 'done'),
        dataEdge('d1', 'mk', 'array', 'fe', 'array'),
        dataEdge('d2', 'fe', 'element', 'prB', 'value'),
      ],
    ),
  });
}

/** var.set：变量写入（value 内联默认值；写后链继续） */
function execVarSet(): IRAsset {
  return asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('set', 'var.set', { params: { varName: 'count' }, pinDefaults: { value: 5 } }),
          node('pr', 'system.print', { pinDefaults: { value: 'done' } }),
        ],
        [execEdge('x1', 'st', 'set'), execEdge('x2', 'set', 'pr')],
      ),
    },
    { variables: [{ name: 'count', type: 'int', default: 0 }] },
  );
}

/** ui.get：获取 UI 节点对象（数据型节点：无 exec 脚，属性式 ui.<n> 读出） */
function execUiGet(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('gv', 'ui.get', { pinDefaults: { name: 'list' } }),
        node('pr', 'system.print'),
      ],
      [execEdge('x1', 'st', 'pr'), dataEdge('d1', 'gv', 'object', 'pr', 'value')],
    ),
  });
}

/** ui.setValue：写 UI 属性（attr 缺省 = spec 默认 'text' → 属性式赋值语句） */
function execUiSetValue(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('w', 'ui.setValue', { pinDefaults: { name: 'title', value: '你好' } }),
        node('pr', 'system.print', { pinDefaults: { value: 'ok' } }),
      ],
      [execEdge('x1', 'st', 'w'), execEdge('x2', 'w', 'pr')],
    ),
  });
}

/** ui.setVisible：显隐（visible 显式非默认值 false → 引脚默认值往返） */
function execUiSetVisible(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('v', 'ui.setVisible', { pinDefaults: { name: 'list', visible: false } }),
        node('pr', 'system.print', { pinDefaults: { value: 'ok' } }),
      ],
      [execEdge('x1', 'st', 'v'), execEdge('x2', 'v', 'pr')],
    ),
  });
}

/** ui.listSetItems：列表项（items 接数组变量 → 属性式赋值 + var.get 重建） */
function execUiListSetItems(): IRAsset {
  return asset(
    {
      main: graph(
        [
          node('st', 'event.start'),
          node('rowsGet', 'var.get', { params: { varName: 'rows' } }),
          node('l', 'ui.listSetItems', { pinDefaults: { name: 'list' } }),
          node('pr', 'system.print', { pinDefaults: { value: 'ok' } }),
        ],
        [
          execEdge('x1', 'st', 'l'),
          execEdge('x2', 'l', 'pr'),
          dataEdge('d1', 'rowsGet', 'value', 'l', 'items'),
        ],
      ),
    },
    { variables: [{ name: 'rows', type: 'string[]' }] },
  );
}

/** ui.setTitle：设置标题（name/value 内联默认值，attr 走 spec 默认 'title' →
 * 属性式赋值语句 `ui.<n>.title = v`；解析端按属性名反查还原节点类型） */
function execUiSetTitle(): IRAsset {
  return asset({
    main: graph(
      [
        node('st', 'event.start'),
        node('t', 'ui.setTitle', { pinDefaults: { name: 'title', value: '你好' } }),
        node('pr', 'system.print', { pinDefaults: { value: 'ok' } }),
      ],
      [execEdge('x1', 'st', 't'), execEdge('x2', 't', 'pr')],
    ),
  });
}

/** system.print：打印（value 内联默认值 → print(字面量)） */
function execSystemPrint(): IRAsset {
  return asset({
    main: graph(
      [node('st', 'event.start'), node('pr', 'system.print', { pinDefaults: { value: '你好，蓝图' } })],
      [execEdge('x1', 'st', 'pr')],
    ),
  });
}

/** 执行节点样本定义表（id 唯一；新增可映射执行节点在此登记最小图构造器） */
interface ExecNodeSampleDef {
  id: string;
  build: () => IRAsset;
  note: string;
}

const execNodeSampleDefs: ExecNodeSampleDef[] = [
  { id: 'event.start', build: execEventStart, note: 'start 入口 → 打印' },
  { id: 'event.custom', build: execEventCustom, note: '自定义事件入口 + 事件参数引用' },
  { id: 'event.send', build: execEventSend, note: 'emit(name) 单参形态' },
  { id: 'event.listen', build: execEventListen, note: 'onEvent + args 参数注入' },
  { id: 'flow.branch', build: execFlowBranch, note: 'if/else 两臂终止形态' },
  { id: 'flow.sequence', build: execFlowSequence, note: '序列状态机：链尾回连 exec 入 + __bps-seq 标记重建' },
  { id: 'flow.forLoop', build: execFlowForLoop, note: '计数循环 + 体尾回连 + done' },
  { id: 'flow.whileLoop', build: execFlowWhileLoop, note: '条件循环（变量条件）' },
  { id: 'flow.delay', build: execFlowDelay, note: 'await delay（字面量秒，done 续链）' },
  { id: 'array.forEach', build: execArrayForEach, note: 'for..of entries 遍历' },
  { id: 'var.set', build: execVarSet, note: '变量写入 + 缺省引脚值' },
  { id: 'ui.get', build: execUiGet, note: '数据型节点：属性式 ui.<n>' },
  { id: 'ui.setValue', build: execUiSetValue, note: '属性式写值（attr 走 spec 默认）' },
  { id: 'ui.setTitle', build: execUiSetTitle, note: '设置标题（attr 缺省 title，属性反查重建）' },
  { id: 'ui.setVisible', build: execUiSetVisible, note: '显隐（显式 false 引脚值）' },
  { id: 'ui.listSetItems', build: execUiListSetItems, note: '列表项 ← 数组变量' },
  { id: 'system.print', build: execSystemPrint, note: 'print(字面量)' },
  { id: 'system.readFile', build: execSystemReadFile, note: '读项目文件 → 打印行数（路径字面量）' },
];

/** 有显式样本的执行节点 id 集合（auditCoverage 的「已入库」判定依据之一） */
export const EXEC_NODE_SAMPLE_IDS: ReadonlySet<string> = new Set(execNodeSampleDefs.map((d) => d.id));

/**
 * 取一个节点的 roundtrip 样本：
 *  - 执行节点 → 显式样本（execNodeSampleDefs）；
 *  - 纯节点 → 共享构造器 pureNodeSample（自动覆盖，无需登记）。
 * 无样本可取时抛错（auditCoverage 会先行拦截并给出更友好的入库指引）。
 */
export function nodeSample(specId: string): IRAsset {
  const def = execNodeSampleDefs.find((d) => d.id === specId);
  if (def) return def.build();
  const spec = builtinSpecMap.get(specId);
  if (spec && spec.pure === true) return pureNodeSample(specId);
  throw new Error(
    `节点「${specId}」无 roundtrip 样本：既无执行节点样本（tests/roundtrip/samples.ts execNodeSampleDefs），也非纯节点（pureNodeSample 自动覆盖范围）。` +
      '新节点必须补样例入库，或（确认暂无脚本映射时）登记 KNOWN_UNMAPPED_NODE_IDS。',
  );
}

/* ============================================================
 * 真实资产样本（templates/log-analyzer/logic/main.bp.json）
 * ============================================================ */

const TEMPLATE_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'templates',
  'log-analyzer',
  'logic',
  'main.bp.json',
);

/** 读取真实资产模板（deserializeIR：JSON → 迁移 → 结构校验 → 规范形） */
function loadLogAnalyzerTemplate(): IRAsset {
  return deserializeIR(readFileSync(TEMPLATE_FILE, 'utf8'));
}

/** 演化二：在真实资产上追加片段节点（模拟编辑器「双击链上插入片段」），验证片段演化往返 */
function realAssetWithSnippetSample(): IRAsset {
  const base = loadLogAnalyzerTemplate();
  const evolved: IRAsset = {
    ...base,
    snippets: [
      {
        id: 'snipInit',
        lang: 'ts',
        code: 'print("已初始化");',
        pins: [
          { id: 'exec', dir: 'in', type: 'exec' },
          { id: 'exec', dir: 'out', type: 'exec' },
        ],
      },
    ],
  };
  const bind = evolved.graphs['bind']!;
  evolved.graphs['bind'] = {
    nodes: [
      ...bind.nodes,
      node('n_snip', 'script.snippet', { params: { snippet: 'snipInit' }, position: { x: 400, y: 200 } }),
    ],
    edges: [...bind.edges, execEdge('e_snip', 'n_print', 'n_snip')], // 挂链尾（exec 出脚单线，UE5 语义）
  };
  return evolved;
}

/* ============================================================
 * 注册表（数组：{ name, kind, build }；name 全表唯一）
 * ============================================================ */

/** 样本类别：node = 逐节点样本；scenario = 业务场景；snippet = 片段专项；asset = 真实资产 */
export type SampleKind = 'node' | 'scenario' | 'snippet' | 'asset';

export interface RoundtripSample {
  /** 样本名（节点 id / 场景名 / 资产名） */
  name: string;
  kind: SampleKind;
  /** 构造样本资产（可重复调用；roundtripIR 不修改输入） */
  build(): IRAsset;
  /** 中文说明 */
  note?: string;
}

/** 逐节点样本：17 个可往返执行节点显式样本 + 52 个纯节点（共享构造器自动生成） */
const nodeSamples: RoundtripSample[] = [
  ...execNodeSampleDefs.map<RoundtripSample>((d) => ({
    name: d.id,
    kind: 'node',
    build: d.build,
    note: `执行节点样本：${d.note}`,
  })),
  ...builtinSpecs
    .filter((s) => s.pure === true)
    .map<RoundtripSample>((s) => ({
      name: s.id,
      kind: 'node',
      build: () => pureNodeSample(s.id),
      note: '纯节点样本（共享构造器 pureNodeSample：引脚取 spec 默认值/字面量，结果交给 system.print）',
    })),
];

/** 业务场景样本（复用基座 T3.5/T3.6 样本库；单源 re-export，不复制构造） */
const scenarioSamples: RoundtripSample[] = [
  {
    name: 'scenario:全特性手工样本',
    kind: 'scenario',
    build: () => fullFeatureAsset,
    note: '事件/分支/双循环/函数图/片段/ui/透传别名/孤儿事件（基座样本①）',
  },
  {
    name: 'scenario:条件循环计数',
    kind: 'scenario',
    build: () => counterAsset,
    note: '分支汇合/循环后引用索引/透传别名（基座样本②）',
  },
  {
    name: 'scenario:日志分析管线',
    kind: 'scenario',
    build: () => logPipelineAsset,
    note: 'androidLogParse 双输出别名 + filter + ui.listSetItems（基座样本③）',
  },
  {
    name: 'scenario:字符串处理链',
    kind: 'scenario',
    build: () => stringChainAsset,
    note: '模板拼接/共享别名/json/map.get/regexMatch（基座样本④）',
  },
];

/** 片段节点专项样本（T3.7，ADR-007：引脚重建 / 折叠推导幂等） */
const snippetSamples: RoundtripSample[] = [
  {
    name: 'snippet:多片段引脚重建',
    kind: 'snippet',
    build: () => multiSnippetAsset,
    note: 'exec 片段引脚连线/纯片段前奏/链尾/孤儿多引脚（基座样本⑩）',
  },
];

/** 真实资产样本（templates/log-analyzer：读取 + 片段演化） */
const assetSamples: RoundtripSample[] = [
  {
    name: 'asset:log-analyzer-template',
    kind: 'asset',
    build: loadLogAnalyzerTemplate,
    note: '真实资产模板 templates/log-analyzer/logic/main.bp.json 读取 → roundtrip',
  },
  {
    name: 'asset:log-analyzer-template+snippet',
    kind: 'asset',
    build: realAssetWithSnippetSample,
    note: '真实资产 + 追加片段节点（片段演化往返）',
  },
];

/** 全部 roundtrip 样本注册表（门禁测试遍历此表） */
export const roundtripSamples: RoundtripSample[] = [
  ...nodeSamples,
  ...scenarioSamples,
  ...snippetSamples,
  ...assetSamples,
];

/* ============================================================
 * 覆盖审计（计数守卫）
 * ============================================================ */

/** 覆盖审计结果（TA.1 门禁的判定数据） */
export interface CoverageAudit {
  /** builtinSpecs 总数 */
  total: number;
  /** 已测节点（有样本入库且不在跳过清单） */
  tested: string[];
  /** 已知跳过节点（登记在 KNOWN_UNMAPPED_NODE_IDS） */
  skipped: string[];
  /** 既无样本又未登记跳过的节点 —— 门禁红灯依据（新节点静默漏测即出现在此） */
  missing: string[];
  /** 跳过清单中的陈旧条目（节点库中已不存在） */
  stale: string[];
}

/** 单个 spec 是否「已入库样本」：执行节点查显式样本表；纯节点由共享构造器自动覆盖 */
function isSampled(spec: Pick<NodeSpec, 'id'> & { pure?: boolean }): boolean {
  if (EXEC_NODE_SAMPLE_IDS.has(spec.id)) return true;
  return spec.pure === true;
}

/**
 * 覆盖审计（纯函数，便于「计数守卫」用例直接断言机制本身）：
 * 把节点清单按「已测 / 已知跳过 / 漏测」三分，并校验跳过清单无陈旧条目。
 * 门禁恒等式：total = tested.length + skipped.length（missing 与 stale 必须为空数组）。
 */
export function auditCoverage(
  specs: readonly (Pick<NodeSpec, 'id'> & { pure?: boolean })[],
  knownUnmapped: ReadonlySet<string>,
): CoverageAudit {
  const specIds = new Set(specs.map((s) => s.id));
  const tested: string[] = [];
  const skipped: string[] = [];
  const missing: string[] = [];
  for (const s of specs) {
    if (knownUnmapped.has(s.id)) skipped.push(s.id);
    else if (isSampled(s)) tested.push(s.id);
    else missing.push(s.id);
  }
  const stale = [...knownUnmapped].filter((id) => !specIds.has(id)).sort();
  return { total: specs.length, tested, skipped, missing, stale };
}
