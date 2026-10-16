/**
 * 主题 token 一致性测试（T0.8）
 *
 * 校验 theme.css 中每个 `--xxx: value` 声明与 tokens.ts 的 TOKENS 值完全一致，
 * 并验证 pinColor 的类型映射契约（PLAN §8.1 引脚色）。
 *
 * 运行：npx tsx --test src/shell/theme/theme.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  TOKENS,
  COLORS,
  PIN_COLORS,
  NODE_HEAD_COLORS,
  EDGE_COLORS,
  NODE_COLORS,
  CANVAS_COLORS,
  SPACING,
  FONTS,
  LAYOUT,
  pinColor,
  type TokenName,
} from './tokens';

/** 解析 theme.css：返回 CSS 变量名 → 归一化值，以及每个名字的声明次数 */
async function parseThemeCss(): Promise<{ decls: Map<string, string>; counts: Map<string, number> }> {
  const cssPath = fileURLToPath(new URL('./theme.css', import.meta.url));
  const text = await readFile(cssPath, 'utf8');
  const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = new Map<string, string>();
  const counts = new Map<string, number>();
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;{}]+)[;{}]/g;
  for (const m of withoutComments.matchAll(re)) {
    const name = `--${m[1]}`;
    decls.set(name, m[2].replace(/\s+/g, ' ').trim());
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return { decls, counts };
}

/** DoD 硬性要求的全部 token 名（任务卡 T0.8 Token 清单 + PLAN §8.1） */
const REQUIRED_TOKENS = [
  // 基础（Godot 深色）
  '--bg-app', '--bg-panel', '--bg-panel-header', '--bg-input', '--bg-canvas',
  '--border', '--border-strong',
  '--text', '--text-dim', '--text-disabled',
  '--accent', '--accent-hover', '--selection', '--focus-ring',
  '--success', '--warning', '--error',
  '--space-1', '--space-2', '--space-3', '--space-4',
  '--space-5', '--space-6', '--space-7', '--space-8',
  '--radius-sm', '--radius-md',
  '--font-xs', '--font-sm', '--font-md', '--font-lg', '--font-mono', '--font-ui',
  '--panel-header-h', '--toolbar-h', '--tab-h',
  // UE5 蓝图专用（引脚色）
  '--pin-exec', '--pin-bool', '--pin-int', '--pin-float', '--pin-string', '--pin-object', '--pin-any',
  // 节点头分类配色（变量 Get/Set 为无头紧凑样式：--node-var-bg / --node-var-border）
  '--node-head-event', '--node-head-function', '--node-head-pure', '--node-head-flow',
  '--node-head-plugin', '--node-var-bg', '--node-var-border',
  // 连线
  '--edge-exec', '--edge-data-default', '--edge-selected',
  // 画布
  '--bp-grid-dot', '--bp-comment-bg', '--bp-comment-border',
  // 节点体
  '--node-bg', '--node-border', '--node-selected', '--node-title-h',
] as const;

test('theme.css 中每个 --token 声明与 tokens.ts TOKENS 值一致且无重复声明', async () => {
  const { decls, counts } = await parseThemeCss();

  // 每个 TOKENS 条目在 CSS 中恰好声明一次且值一致
  for (const [name, value] of Object.entries(TOKENS)) {
    assert.equal(counts.get(name), 1, `${name} 应在 theme.css 中恰好声明一次`);
    assert.equal(decls.get(name), value, `${name} 的 CSS 值应与 tokens.ts 一致`);
  }

  // CSS 中不允许出现 tokens.ts 未登记的 token（防漂移 / 拼写错）
  for (const name of decls.keys()) {
    assert.ok(name in TOKENS, `theme.css 中的 ${name} 未登记到 tokens.ts TOKENS`);
  }
});

test('DoD 要求的 token 名称全部存在', async () => {
  const { decls } = await parseThemeCss();
  for (const name of REQUIRED_TOKENS) {
    assert.ok(decls.has(name), `缺少 DoD 要求的 token：${name}`);
    assert.ok(name in TOKENS, `缺少 DoD 要求的 token（TS 侧）：${name}`);
  }
});

test('分组常量输出的都是指向已登记 token 的 var() 引用', async () => {
  const { decls } = await parseThemeCss();
  const groups: Array<[string, Record<string, string>]> = [
    ['COLORS', COLORS],
    ['PIN_COLORS', PIN_COLORS],
    ['NODE_HEAD_COLORS', NODE_HEAD_COLORS],
    ['EDGE_COLORS', EDGE_COLORS],
    ['NODE_COLORS', NODE_COLORS],
    ['CANVAS_COLORS', CANVAS_COLORS],
    ['SPACING', SPACING],
    ['FONTS', FONTS],
    ['LAYOUT', LAYOUT],
  ];
  for (const [label, group] of groups) {
    for (const [key, value] of Object.entries(group)) {
      assert.match(value, /^var\(--[a-z0-9-]+\)$/, `${label}.${key} 应为 var() 引用，实际：${value}`);
      const name = value.slice(4, -1) as TokenName;
      assert.ok(decls.has(name), `${label}.${key} 引用的 ${name} 未在 theme.css 中声明`);
      assert.equal(decls.get(name), TOKENS[name], `${label}.${key} 引用的 ${name} 值与 tokens.ts 不一致`);
    }
  }
});

test('pinColor：基本引脚类型映射到 UE5 标准引脚色（PLAN §8.1）', () => {
  assert.equal(pinColor('exec'), PIN_COLORS.exec);
  assert.equal(pinColor('bool'), PIN_COLORS.bool);
  assert.equal(pinColor('int'), PIN_COLORS.int);
  assert.equal(pinColor('float'), PIN_COLORS.float);
  assert.equal(pinColor('string'), PIN_COLORS.string);
  assert.equal(pinColor('object'), PIN_COLORS.object);
  assert.equal(pinColor('any'), PIN_COLORS.any);
});

test('pinColor：数组类型映射到元素类型色，number 别名归 float，未知类型回退 any', () => {
  assert.equal(pinColor('string[]'), PIN_COLORS.string);
  assert.equal(pinColor('int[]'), PIN_COLORS.int);
  assert.equal(pinColor('object[]'), PIN_COLORS.object);
  assert.equal(pinColor('float[][]'), PIN_COLORS.float);
  assert.equal(pinColor(' number '), PIN_COLORS.float); // IR 事件参数历史别名（PLAN §5 示例）
  assert.equal(pinColor('SomeUnknownType'), PIN_COLORS.any);
  assert.equal(pinColor(''), PIN_COLORS.any);
});

test('色值格式合法：hex 为 6 位、rgba 四分量、尺寸带 px 单位', async () => {
  const sizeNameRe =
    /^--(space-[1-8]|radius-(sm|md)|font-(xs|sm|md|lg)|panel-header-h|toolbar-h|tab-h|node-title-h)$/;
  for (const [name, value] of Object.entries(TOKENS)) {
    if (value.startsWith('#')) {
      assert.match(value, /^#[0-9a-f]{6}$/, `${name} 应为 6 位小写 hex，实际：${value}`);
    } else if (value.startsWith('rgba')) {
      assert.match(value, /^rgba\(\d{1,3}, \d{1,3}, \d{1,3}, (?:0|1|0?\.\d+)\)$/, `${name} rgba 格式非法：${value}`);
    } else if (sizeNameRe.test(name)) {
      assert.match(value, /^-?\d+(\.\d+)?px$/, `${name} 尺寸 token 应带 px 单位，实际：${value}`);
    }
  }
});
