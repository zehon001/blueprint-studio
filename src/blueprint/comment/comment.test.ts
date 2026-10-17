/**
 * Blueprint Studio v2 —— 注释框单测（node:test，T2.7 / ADR-006）
 *
 * 覆盖（任务卡 T2.7 测试清单）：
 *  1. containsNode 几何判定：完全包含（含边界相切）/ 相交但不包含 / 不相交
 *  2. 移动注释 → 内含节点 position 随动、边界外节点不动（store 级真实命令 + undo 还原）
 *  3. 颜色 / 文本 / 删除命令 + undo（删除只删注释不动节点；Delete 走 deleteSelection 分流）
 *  4. IR 往返：含 comments 的资产 serialize→deserialize 深等；无 comments 资产
 *     normalize 后无该字段（缺省 / 空数组剔除）
 *  5. validate.test.ts 另有 comments 结构错误被 deserializeIR 拒绝的用例（本文件不重复）
 *
 * store 级测试走真实 runCommand（registerDomainState → commit → undo/redo），
 * 与 interaction.test.ts §10 同款接线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IRAsset, IRComment, IRGraph, IRNode } from '../../ir/types';
import { deserializeIR, normalizeIR, serializeIR } from '../../ir/validate';
import {
  getDomainState,
  peekRedo,
  peekUndo,
  redo,
  resetEditorStore,
  subscribeReplay,
  undo,
} from '../../shell/commands';
import { useBlueprintStore } from '../store/blueprint-store';
import {
  clampCommentBounds,
  commentIdFromSelectionId,
  commentSelectionId,
  COMMENT_PRESET_COLORS,
  COMMENT_SELECTION_PREFIX,
  commentsOf,
  containedNodeIds,
  containsNode,
  DEFAULT_COMMENT_SIZE,
  estimatedNodeSizeOf,
  MIN_COMMENT_SIZE,
  rectsIntersect,
  type NodeSizeResolver,
} from './model';

/* ============================================================
 * 样本构造
 * ============================================================ */

function irNode(id: string, type: string, position: { x: number; y: number }): IRNode {
  return { id, type, params: {}, pinDefaults: {}, position };
}

function comment(
  id: string,
  bounds: { x: number; y: number; w: number; h: number },
  extra?: Partial<Omit<IRComment, 'id' | 'bounds'>>,
): IRComment {
  return { id, text: `注释${id}`, bounds, ...extra };
}

/** store 接线样本：1 条注释框（0,0,400,300）+ 内含节点 A（30,40）+ 边界外节点 B（500,400）+ 相交节点 C（380,260 起步超出右下角） */
function commentAsset(): IRAsset {
  const main: IRGraph = {
    nodes: [
      irNode('A', 'event.start', { x: 30, y: 40 }),    // 完全包含
      irNode('B', 'system.print', { x: 500, y: 400 }), // 注释外
      irNode('C', 'flow.branch', { x: 380, y: 260 }),  // 相交但不完全包含
    ],
    edges: [],
    comments: [comment('c1', { x: 0, y: 0, w: 400, h: 300 })],
  };
  return {
    version: 2,
    name: '注释样本',
    entry: 'main',
    graphs: { main },
    variables: [],
    events: [],
    snippets: [],
    layout: {},
  };
}

/** 显式节点尺寸（隔离估算误差：A/B/C 全按 190×96 常规节点） */
const FIXED_SIZES: ReadonlyMap<string, { width: number; height: number }> = new Map([
  ['A', { width: 190, height: 96 }],
  ['B', { width: 190, height: 96 }],
  ['C', { width: 190, height: 96 }],
]);

function sizeResolverOf(sizes: ReadonlyMap<string, { width: number; height: number }>): NodeSizeResolver {
  return (node) => sizes.get(node.id) ?? { width: 190, height: 96 };
}

/** 按钩子的方式接镜像刷新（useCanvasInteractions 同款订阅；隔离测试用） */
function attachMirrorRefresh(): () => void {
  return subscribeReplay((notice) => {
    if (notice.domains.includes('blueprint')) {
      useBlueprintStore.getState().refreshFromDomain();
    }
  });
}

function domainAsset(): IRAsset {
  return getDomainState<{ asset: IRAsset }>('blueprint').asset;
}

/** 域状态中当前图的节点位置 */
function domainNodePos(nodeId: string): { x: number; y: number } {
  const graph = domainAsset().graphs[useBlueprintStore.getState().graphName]!;
  return { ...graph.nodes.find((n) => n.id === nodeId)!.position };
}

function domainComment(id: string): IRComment {
  const graph = domainAsset().graphs[useBlueprintStore.getState().graphName]!;
  const hit = graph.comments?.find((c) => c.id === id);
  assert.ok(hit, `域状态中应有注释 ${id}`);
  return hit;
}

/* ============================================================
 * 1. containsNode 几何判定（完全包含 / 相交 / 不相交）
 * ============================================================ */

test('containsNode：完全包含（含边界相切）为真；相交但不包含与不相交为假', () => {
  const box = { x: 0, y: 0, w: 400, h: 300 };
  // 完全包含
  assert.equal(containsNode(box, { x: 10, y: 10, w: 100, h: 50 }), true);
  // 边界相切（右/下缘与注释边缘重合）仍算包含（UE 同款）
  assert.equal(containsNode(box, { x: 200, y: 250, w: 200, h: 50 }), true);
  assert.equal(containsNode(box, { x: 0, y: 0, w: 400, h: 300 }), true, '与注释等大的节点算包含');
  // 相交但不完全包含（超出右下角 / 左上角）
  assert.equal(containsNode(box, { x: 300, y: 250, w: 200, h: 100 }), false);
  assert.equal(containsNode(box, { x: -10, y: -10, w: 100, h: 50 }), false);
  // 完全在外
  assert.equal(containsNode(box, { x: 500, y: 400, w: 100, h: 50 }), false);
});

test('rectsIntersect：重叠为真、贴边与分离为假', () => {
  const a = { x: 0, y: 0, w: 100, h: 100 };
  assert.equal(rectsIntersect(a, { x: 50, y: 50, w: 100, h: 100 }), true, '部分重叠');
  assert.equal(rectsIntersect(a, { x: 0, y: 0, w: 100, h: 100 }), true, '完全重合');
  assert.equal(rectsIntersect(a, { x: 100, y: 0, w: 50, h: 50 }), false, '贴右缘不相交');
  assert.equal(rectsIntersect(a, { x: 0, y: 100, w: 50, h: 50 }), false, '贴下缘不相交');
  assert.equal(rectsIntersect(a, { x: 200, y: 200, w: 10, h: 10 }), false, '分离');
});

test('containedNodeIds：按 sizeOf 解析节点矩形，只返回完全包含者（保持节点顺序）', () => {
  const graph = commentAsset().graphs['main']!;
  const inside = containedNodeIds(
    comment('c1', { x: 0, y: 0, w: 400, h: 300 }).bounds,
    graph.nodes,
    sizeResolverOf(FIXED_SIZES),
  );
  assert.deepEqual(inside, ['A'], '仅完全包含的 A 命中（C 相交不包含、B 在外）');
});

test('clampCommentBounds：宽高钳到最小尺寸，非法数字回落 0，不改入参', () => {
  const clamped = clampCommentBounds({ x: -50, y: 20, w: 10, h: Number.NaN });
  assert.deepEqual(clamped, { x: -50, y: 20, w: MIN_COMMENT_SIZE.w, h: MIN_COMMENT_SIZE.h });
  assert.deepEqual(clampCommentBounds(null), { x: 0, y: 0, w: MIN_COMMENT_SIZE.w, h: MIN_COMMENT_SIZE.h });
  const src = { x: 1, y: 2, w: 3, h: 4 };
  clampCommentBounds(src);
  assert.deepEqual(src, { x: 1, y: 2, w: 3, h: 4 }, '入参对象不被修改');
});

test('选中集 id 前缀换算 + estimatedNodeSizeOf 兜底 + 预设色板 6 色', () => {
  assert.equal(commentSelectionId('c1'), 'comment:c1');
  assert.equal(commentIdFromSelectionId('comment:c1'), 'c1');
  assert.equal(commentIdFromSelectionId('branch_1'), null, '节点 id 不被误判为注释');
  assert.equal(COMMENT_SELECTION_PREFIX, 'comment:');

  const specs = new Map();
  const estimate = estimatedNodeSizeOf(specs);
  assert.deepEqual(estimate(irNode('x', 'event.start', { x: 0, y: 0 })), { width: 190, height: 96 }, '未知 spec 估算常规节点');

  assert.equal(COMMENT_PRESET_COLORS.length, 6, 'DoD 3：预设色板 6 色');
  for (const preset of COMMENT_PRESET_COLORS) {
    assert.match(preset.value, /^#[0-9a-fA-F]{6}$/, '色板值必须是 hex（可被 color input 回读）');
    assert.ok(preset.label.length > 0);
  }
});

/* ============================================================
 * 2. store 级真实命令：移动注释 → 内含节点随动 + undo 还原
 * ============================================================ */

test('store 接线：addComment 在光标处创建默认尺寸注释并进入选中集（label「注释：新建」）', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    useBlueprintStore.getState().openAsset(commentAsset(), 'logic/main.bp.json');
    const id = useBlueprintStore.getState().addComment({ x: 123, y: 47 }, '初始化段');
    assert.ok(id, 'addComment 返回新注释 id');
    const created = domainComment(id);
    assert.equal(created.text, '初始化段');
    assert.equal(created.bounds.w, DEFAULT_COMMENT_SIZE.w, '默认尺寸');
    assert.equal(created.bounds.h, DEFAULT_COMMENT_SIZE.h);
    assert.deepEqual(
      useBlueprintStore.getState().selection.nodeIds,
      [commentSelectionId(id)],
      '创建后注释进入选中集（comment: 前缀）',
    );
    assert.ok(peekUndo()?.label === '注释：新建', '命令 label 前缀「注释：…」');

    // 空文本回落「注释」
    const id2 = useBlueprintStore.getState().addComment({ x: 0, y: 0 });
    assert.equal(domainComment(id2!).text, '注释');
  } finally {
    detach();
    resetEditorStore();
  }
});

test('store 接线：移动注释 → 内含节点 position 随动、边界外与相交节点不动；undo 一步全还原', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    useBlueprintStore.getState().openAsset(commentAsset(), 'logic/main.bp.json');
    const before = {
      a: domainNodePos('A'),
      b: domainNodePos('B'),
      c: domainNodePos('C'),
      comment: { ...domainComment('c1').bounds },
    };

    // 拖动注释：bounds 平移 (+60, +40)（尺寸不变）
    useBlueprintStore.getState().moveComment(
      'c1',
      { x: 60, y: 40, w: 400, h: 300 },
      FIXED_SIZES,
    );
    const after = domainComment('c1');
    assert.deepEqual(after.bounds, { x: 60, y: 40, w: 400, h: 300 }, '注释 bounds 更新');
    assert.deepEqual(domainNodePos('A'), { x: before.a.x + 60, y: before.a.y + 40 }, '内含节点 A 随注释平移');
    assert.deepEqual(domainNodePos('B'), before.b, '注释外节点 B 不动');
    assert.deepEqual(domainNodePos('C'), before.c, '相交但不完全包含的节点 C 不动（UE 行为）');
    assert.ok(peekUndo()?.label === '注释：移动', '移动入命令栈');

    // undo：注释 bounds 与节点位置同一条命令，一步还原
    const notice = undo();
    assert.ok(notice && notice.domains.includes('blueprint'));
    assert.deepEqual(domainComment('c1').bounds, before.comment, 'undo 还原注释 bounds');
    assert.deepEqual(domainNodePos('A'), before.a, 'undo 还原内含节点位置');
    assert.deepEqual(domainNodePos('B'), before.b);
    assert.deepEqual(domainNodePos('C'), before.c);
    assert.ok(peekRedo()?.label === '注释：移动');

    // redo 恢复
    redo();
    assert.deepEqual(domainComment('c1').bounds, { x: 60, y: 40, w: 400, h: 300 });
    assert.deepEqual(domainNodePos('A'), { x: before.a.x + 60, y: before.a.y + 40 });
  } finally {
    detach();
    resetEditorStore();
  }
});

test('store 接线：resize / 大小重置只改注释框，内含节点不随 resize 移动', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    useBlueprintStore.getState().openAsset(commentAsset(), 'logic/main.bp.json');
    const aBefore = domainNodePos('A');

    useBlueprintStore.getState().resizeComment('c1', { x: 0, y: 0, w: 200, h: 100 });
    assert.deepEqual(domainComment('c1').bounds, { x: 0, y: 0, w: 200, h: 100 });
    assert.deepEqual(domainNodePos('A'), aBefore, '内含节点不随 resize 移动');

    // 越界 resize 被 clampCommentBounds 钳制
    useBlueprintStore.getState().resizeComment('c1', { x: 0, y: 0, w: 10, h: 10 });
    assert.equal(domainComment('c1').bounds.w, MIN_COMMENT_SIZE.w);
    assert.equal(domainComment('c1').bounds.h, MIN_COMMENT_SIZE.h);

    // 大小重置：保持左上角，恢复默认尺寸
    useBlueprintStore.getState().resetCommentSize('c1');
    assert.deepEqual(domainComment('c1').bounds, {
      x: 0,
      y: 0,
      w: DEFAULT_COMMENT_SIZE.w,
      h: DEFAULT_COMMENT_SIZE.h,
    });
    assert.ok(peekUndo()?.label === '注释：大小重置');
  } finally {
    detach();
    resetEditorStore();
  }
});

/* ============================================================
 * 3. 颜色 / 文本 / 删除命令 + undo
 * ============================================================ */

test('store 接线：颜色 / 文本命令 + undo；空文本拒绝', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    useBlueprintStore.getState().openAsset(commentAsset(), 'logic/main.bp.json');

    // 颜色：预设色 → 恢复默认（undefined 剔除字段）
    useBlueprintStore.getState().setCommentColor('c1', COMMENT_PRESET_COLORS[0].value);
    assert.equal(domainComment('c1').color, COMMENT_PRESET_COLORS[0].value);
    assert.ok(peekUndo()?.label === '注释：改颜色');
    undo();
    assert.equal('color' in domainComment('c1'), false, 'undo 后 color 字段剔除');

    useBlueprintStore.getState().setCommentColor('c1', '#112233');
    useBlueprintStore.getState().setCommentColor('c1', undefined);
    assert.equal('color' in domainComment('c1'), false, 'undefined 恢复默认（字段剔除）');

    // 文本：改名入栈；undo 还原；空文本拒绝
    assert.equal(useBlueprintStore.getState().setCommentText('c1', '  初始化段  '), true);
    assert.equal(domainComment('c1').text, '初始化段', '文本 trim 后入库');
    assert.ok(peekUndo()?.label === '注释：重命名');
    undo();
    assert.equal(domainComment('c1').text, '注释c1', 'undo 还原文本');

    assert.equal(useBlueprintStore.getState().setCommentText('c1', '   '), false, '空文本拒绝');
    assert.equal(domainComment('c1').text, '注释c1', '拒绝后文本不变');
  } finally {
    detach();
    resetEditorStore();
  }
});

test('store 接线：删除注释（removeComments / deleteSelection 的 comment: 分流）只删注释不动节点，undo 可还原', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    useBlueprintStore.getState().openAsset(commentAsset(), 'logic/main.bp.json');

    // removeComments：节点与连线原样保留
    useBlueprintStore.getState().removeComments(['c1']);
    assert.equal(commentsOf(domainAsset(), 'main').length, 0, '注释被删除');
    const graph = domainAsset().graphs['main']!;
    assert.deepEqual(
      graph.nodes.map((n) => n.id),
      ['A', 'B', 'C'],
      '节点不受删除注释影响',
    );
    assert.ok(peekUndo()?.label === '注释：删除');
    undo();
    assert.ok(domainComment('c1'), 'undo 还原注释');

    // deleteSelection 分流：selection.nodeIds = ['comment:c1'] → Delete 只删注释
    useBlueprintStore.getState().setSelection({ nodeIds: [commentSelectionId('c1')], edgeIds: [] });
    useBlueprintStore.getState().deleteSelection();
    assert.equal(commentsOf(domainAsset(), 'main').length, 0, 'Delete 删除选中注释');
    assert.equal(domainAsset().graphs['main']!.nodes.length, 3, 'Delete 不动节点');
    assert.ok(peekUndo()?.label === '注释：删除', '纯注释选中 → 删除走注释 label');
    undo();
    assert.ok(domainComment('c1'), 'Delete 的注释删除也可 undo');

    // 混合选中（节点 + 注释）：一条命令删两者（label「删除选中」）
    useBlueprintStore.getState().setSelection({
      nodeIds: ['comment:c1', 'A'],
      edgeIds: [],
    });
    useBlueprintStore.getState().deleteSelection();
    const after = domainAsset().graphs['main']!;
    assert.equal(after.comments?.length ?? 0, 0);
    assert.deepEqual(after.nodes.map((n) => n.id), ['B', 'C']);
    assert.ok(peekUndo()?.label === '删除选中', '混合删除沿用既有 label');
  } finally {
    detach();
    resetEditorStore();
  }
});

test('store 接线：requestCommentFocus 定位请求（跨图查找 + 请求戳）', () => {
  resetEditorStore();
  const detach = attachMirrorRefresh();
  try {
    const asset = commentAsset();
    asset.graphs['aux'] = { nodes: [], edges: [], comments: [comment('cAux', { x: 10, y: 10, w: 100, h: 80 })] };
    useBlueprintStore.getState().openAsset(asset, 'logic/main.bp.json');
    assert.equal(useBlueprintStore.getState().focusComment, null);

    useBlueprintStore.getState().requestCommentFocus('cAux');
    const req = useBlueprintStore.getState().focusComment;
    assert.ok(req, '发出定位请求');
    assert.equal(req!.graphName, 'aux', '跨图找到注释所在图');
    assert.equal(req!.commentId, 'cAux');

    useBlueprintStore.getState().requestCommentFocus('cAux');
    assert.notEqual(
      useBlueprintStore.getState().focusComment,
      req,
      '同一注释重复双击也会再次触发（新请求对象）',
    );

    // 不存在的注释不发请求
    const last = useBlueprintStore.getState().focusComment;
    useBlueprintStore.getState().requestCommentFocus('ghost');
    assert.equal(useBlueprintStore.getState().focusComment, last);
  } finally {
    detach();
    resetEditorStore();
  }
});

/* ============================================================
 * 4. IR 往返：含 comments 资产 serialize→deserialize 深等；无 comments 资产剔除字段
 * ============================================================ */

test('IR 往返：含 comments 的资产 serialize → deserialize 深等（键序规范 + serialize 幂等）', () => {
  const a = commentAsset();
  a.graphs['main']!.comments = [
    { id: 'c1', text: '初始化段', color: '#4f8cc9', bounds: { x: 0, y: 0, w: 400, h: 300 } },
    { id: 'c2', text: '备注', bounds: { x: -100, y: -50, w: 200.5, h: 120 } },
  ];
  const text = JSON.stringify(a); // 先模拟 .bp.json 文本再反序列化
  const restored = deserializeIR(text);
  assert.equal(restored.version, 2, 'version 不因 comments 升级（ADR-006：仍为 2）');
  assert.deepEqual(
    restored.graphs['main']!.comments,
    [
      { id: 'c1', text: '初始化段', color: '#4f8cc9', bounds: { x: 0, y: 0, w: 400, h: 300 } },
      { id: 'c2', text: '备注', bounds: { x: -100, y: -50, w: 200.5, h: 120 } },
    ],
    '注释往返无损（含无 color 注释与负坐标）',
  );

  // serializeIR（规范化输出）→ deserializeIR 深等于 normalizeIR 结果，且序列化幂等
  const s1 = serializeIR(a);
  const restored2 = deserializeIR(s1);
  assert.deepEqual(restored2, JSON.parse(s1), 'deserialize(serialize(a)) 与序列化文本一致');
  assert.equal(s1, serializeIR(restored2), 'serializeIR 幂等');

  // 注释键序规范：id → text → color → bounds；bounds 键序 x → y → w → h
  const parsed = JSON.parse(s1) as { graphs: { main: { comments: Record<string, unknown>[] } } };
  assert.deepEqual(Object.keys(parsed.graphs.main.comments[0]), ['id', 'text', 'color', 'bounds']);
  assert.deepEqual(Object.keys(parsed.graphs.main.comments[1]), ['id', 'text', 'bounds']);
  assert.deepEqual(
    Object.keys(parsed.graphs.main.comments[0]['bounds'] as Record<string, unknown>),
    ['x', 'y', 'w', 'h'],
  );
});

test('normalizeIR：无 comments / 空 comments 资产不含该字段；非法注释条目补零值', () => {
  // 无 comments：normalize 后无该字段（旧资产形态不变）
  const plain = commentAsset();
  delete (plain.graphs['main'] as unknown as { comments?: unknown }).comments;
  const normalized = normalizeIR(plain);
  assert.equal('comments' in normalized.graphs['main']!, false, '无注释 → 字段剔除');
  assert.equal(serializeIR(plain).includes('"comments"'), false, '序列化文本不含 comments 键');

  // 空 comments 数组：与缺省同义，剔除
  const empty = commentAsset();
  (empty.graphs['main'] as unknown as { comments?: unknown }).comments = [];
  assert.equal('comments' in normalizeIR(empty).graphs['main']!, false, '空数组剔除');

  // 非法条目：宽容补零值（结构级缺失由 deserializeIR 把关）
  const dirty = commentAsset();
  (dirty.graphs['main'] as unknown as { comments?: unknown }).comments = [
    { text: '残缺注释' }, // 缺 id / bounds
  ];
  const cleaned = normalizeIR(dirty).graphs['main']!.comments!;
  assert.deepEqual(cleaned, [{ id: '', text: '残缺注释', bounds: { x: 0, y: 0, w: 0, h: 0 } }], '缺省字段补零值');
});
