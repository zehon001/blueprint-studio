/**
 * Blueprint Studio v2 —— UI 节点（对象方法节点风格，PLAN §13.1 ui / §9.2 ui 访问器）
 *
 * 契约现状（T13.1 决策，不改 src/ir/types.ts）：NodeRunContext 目前没有 ui
 * 访问器。这里按 spec.ts 的结构化 UiHandle 探测 ctx.ui——解释器（T2.5）注入
 * 则操作绑定 UI 子树；缺失时经 ctx.print 提示并安全放行执行链（不抛错）。
 * 所需契约能力已上报 PM 协调（NodeRunContext 增补可选 ui 句柄，走 ADR）。
 */
import type { NodeSpec } from '../ir/types';
import {
  defineNode,
  execIn,
  execOut,
  dataIn,
  dataOut,
  selectIn,
  strOf,
  boolOf,
  probeUi,
  warnMissingHook,
  type NodeRunContext,
  type UiHandle,
  opts,
} from './spec';

/** 通用属性下拉候选（select 引脚，规范化决策②） */
const ATTR_VALUE = opts(
  ['text', 'text 文本'], ['value', 'value 值'], ['checked', 'checked 勾选'],
  ['title', 'title 标题'], ['placeholder', 'placeholder 占位'], ['visible', 'visible 可见'],
);
const ATTR_TITLE = opts(['title', 'title 标题'], ['text', 'text 文本'], ['value', 'value 值'], ['placeholder', 'placeholder 占位']);

/** 缺 ui 句柄时的统一降级：提示 + 放行执行链 */
function missingUi(ctx: NodeRunContext): void {
  warnMissingHook(ctx, 'ui', 'ui 节点');
}

/* ----------------------------------------------------------------- ui.get */
export const get = defineNode({
  id: 'ui.get', title: '获取UI节点', category: '界面',
  keywords: ['ui', 'get', '获取节点', '查找节点', '节点对象'],
  doc: '按 name 在绑定 UI 子树中查找节点，输出该节点对象；找不到输出 null。v3：target 为子节点选择器（未连线 name 时使用）。',
  // v3 T12.5：子节点选择器参数（Details 下拉，列出图属主自身树节点名）
  params: [{ id: 'target', label: '子节点', type: 'nodeSelector', default: '' }],
  inputs: [dataIn('name', 'string', '节点名', '')],
  outputs: [dataOut('object', 'uiHandle', '节点对象（UiHandle）')],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { outputs: { object: null } }; }
    const name = strOf(inputs.name) || strOf(ctx.params.target);
    const found = ui.find(name);
    return { outputs: { object: found === undefined ? null : found } };
  },
});

/* ------------------------------------------------------------ ui.getValue */
export const getValue = defineNode({
  id: 'ui.getValue', title: '读取UI值', category: '界面',
  keywords: ['ui', 'getvalue', '读值', '读取属性', 'text', 'checked'],
  doc: '读 UI 节点属性值（attr 可选 text/value/checked/title/placeholder/visible）。',
  pure: true,
  inputs: [
    dataIn('name', 'string', '节点名', ''),
    selectIn('attr', ATTR_VALUE, '属性', 'value'),
  ],
  outputs: [dataOut('value', 'any', '值')],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { outputs: { value: null } }; }
    return { outputs: { value: ui.read(strOf(inputs.name), strOf(inputs.attr) || 'value') } };
  },
});

/* -------------------------------------------------------------- ui.setText */
export const setText = defineNode({
  id: 'ui.setText', title: '设置文本', category: '界面',
  keywords: ['ui', 'settext', '文本', '设置文本', 'text', '标题'],
  doc: '写 UI 节点的 text 属性（目标需具 text trait；value 入参保持 any 兼容，非字符串按原值写入）。',
  traits: ['text'],
  inputs: [
    execIn(),
    dataIn('name', 'string', '节点名', ''),
    { id: 'value', type: 'any', label: '文本', defaultValue: '' },
  ],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { next: 'exec', outputs: {} }; }
    ui.write(strOf(inputs.name), 'text', inputs.value ?? '');
    return { next: 'exec', outputs: {} };
  },
});

/* ------------------------------------------------------------ ui.setValue */
export const setValue = defineNode({
  id: 'ui.setValue', title: '写入UI值', category: '界面',
  keywords: ['ui', 'setvalue', '写值', '设置属性', '赋值'],
  doc: '写 UI 节点属性（attr 可选 text/value/checked/title/placeholder/visible），如 ui.title.text = …。',
  traits: ['value'],
  inputs: [
    execIn(),
    dataIn('name', 'string', '节点名', ''),
    { id: 'value', type: 'any', label: '值', defaultValue: null },
    selectIn('attr', ATTR_VALUE, '属性', 'text'),
  ],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { next: 'exec', outputs: {} }; }
    ui.write(strOf(inputs.name), strOf(inputs.attr) || 'text', inputs.value ?? null);
    return { next: 'exec', outputs: {} };
  },
});

/* ---------------------------------------------------------- ui.setVisible */
export const setVisible = defineNode({
  id: 'ui.setVisible', title: '显示/隐藏', category: '界面',
  keywords: ['ui', 'visible', '显示', '隐藏', '可见性', 'show', 'hide'],
  doc: '设置 UI 节点可见性（写 visible 属性）。',
  inputs: [
    execIn(),
    dataIn('name', 'string', '节点名', ''),
    dataIn('visible', 'bool', '可见', true),
  ],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { next: 'exec', outputs: {} }; }
    ui.write(strOf(inputs.name), 'visible', boolOf(inputs.visible, true));
    return { next: 'exec', outputs: {} };
  },
});

/* ------------------------------------------------------- ui.listSetItems */
export const listSetItems = defineNode({
  id: 'ui.listSetItems', title: '设置列表项', category: '界面',
  keywords: ['ui', 'list', 'items', '列表', '设置列表项', '条目'],
  doc: '写 List 节点的 items 属性（数组；非数组输入转单元素数组）。',
  traits: ['items'],
  inputs: [
    execIn(),
    dataIn('name', 'string', '列表名', ''),
    { id: 'items', type: 'any[]', label: '列表项', defaultValue: null },
  ],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { next: 'exec', outputs: {} }; }
    const items = Array.isArray(inputs.items) ? inputs.items : [inputs.items ?? null];
    ui.write(strOf(inputs.name), 'items', items);
    return { next: 'exec', outputs: {} };
  },
});

/* ----------------------------------------------------------- ui.setTitle */
export const setTitle = defineNode({
  id: 'ui.setTitle', title: '设置标题', category: '界面',
  keywords: ['ui', 'title', 'settitle', '标题', '设置标题'],
  doc: '写文本类属性通用入口（attr 可选 title/text/value/placeholder；value 入参保持 any 兼容）。',
  traits: ['text'],
  inputs: [
    execIn(),
    dataIn('name', 'string', '节点名', ''),
    { id: 'value', type: 'any', label: '文本', defaultValue: '' },
    selectIn('attr', ATTR_TITLE, '属性', 'title'),
  ],
  outputs: [execOut()],
  run: (ctx, inputs) => {
    const ui = probeUi(ctx);
    if (!ui) { missingUi(ctx); return { next: 'exec', outputs: {} }; }
    ui.write(strOf(inputs.name), strOf(inputs.attr) || 'title', strOf(inputs.value));
    return { next: 'exec', outputs: {} };
  },
});

/** 供解释器 / 测试构造 ui 句柄时的形状参考 */
export type { UiHandle };

export const uiNodes: NodeSpec[] = [get, getValue, setText, setValue, setVisible, listSetItems, setTitle];
