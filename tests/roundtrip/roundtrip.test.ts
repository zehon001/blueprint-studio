/**
 * Blueprint Studio v2 —— TA.1 正式门禁：roundtrip 幂等测试框架（IR→TS→IR，含片段节点）
 *
 * 断言口径（PLAN §10 / §20-2）：normalizeIR(asset) ≡ normalizeIR(parse(codegen(asset)))，
 * 幂等二次验证（对 roundtrip 输出再跑一轮 codegen→parse 仍等价）——比较器实现单源在
 * 基座 src/script/roundtrip.test.ts（本目录 roundtrip-helpers.ts re-export，不复制实现）。
 *
 * 门禁机制（DoD「新节点必须补样例入库」）：
 *  ① 遍历 builtinSpecs 全部节点逐节点 roundtrip：纯节点经共享构造器 pureNodeSample
 *     自动覆盖；执行节点须在 samples.ts 显式登记最小图样本；确认暂无脚本映射的执行
 *     节点登记进「已知无映射清单」KNOWN_UNMAPPED_NODE_IDS（当前 8 项）显式跳过；
 *  ② 计数恒等式：builtinSpecs 总数 = 已测数 + 已知跳过数（auditCoverage）——
 *     新增节点不补样本、也不进跳过清单 → missing 非空 → 红灯；「计数守卫」用例
 *     直接断言该机制（模拟删跳过清单条目 / 假想新节点，无需真改文件）。
 *
 * 覆盖：门禁①全节点 → 门禁②真实资产（templates/log-analyzer，含片段演化）→
 *       门禁③业务场景 + 片段专项 → 门禁④全部样本幂等二次验证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { builtinSpecs } from '../../src/nodes';
import { codegenTS } from '../../src/script/codegen-ts';
import { parseScriptToIR } from '../../src/script/parser-ts';
import { serializeIR, deserializeIR } from '../../src/ir/validate';
import { roundtripIR, canonicalIR, noDiags, assertTranspiles } from './roundtrip-helpers';
import { roundtripSamples, nodeSample, auditCoverage, KNOWN_UNMAPPED_NODE_IDS } from './samples';

/* ============================================================
 * 门禁 ①：builtinSpecs 全节点逐个 roundtrip + 计数恒等式
 * ============================================================ */

test('TA.1 门禁 ①：builtinSpecs 全节点逐个 roundtrip（总数 = 已测数 + 已知跳过数）', async () => {
  const audit = auditCoverage(builtinSpecs, KNOWN_UNMAPPED_NODE_IDS);

  // 跳过清单卫生：不得残留节点库已删除的陈旧条目
  assert.deepEqual(
    audit.stale,
    [],
    `「已知无映射清单」含陈旧条目（节点库中已不存在，请同步清理 samples.ts）：${audit.stale.join(', ')}`,
  );

  // 覆盖门禁（DoD 核心）：任何节点要么有样本入库，要么登记在已知跳过清单
  assert.deepEqual(
    audit.missing,
    [],
    `以下节点既无 roundtrip 样本也未登记「已知无映射清单」——新节点必须补样例入库` +
      `（tests/roundtrip/samples.ts：执行节点加 execNodeSampleDefs / 纯节点自动覆盖），` +
      `确认暂无脚本映射时登记 KNOWN_UNMAPPED_NODE_IDS：${audit.missing.join(', ')}`,
  );

  // 逐节点执行 roundtrip（roundtrip 全绿 + 解析零诊断 + 生成码可转译）
  const failures: string[] = [];
  for (const spec of builtinSpecs) {
    if (KNOWN_UNMAPPED_NODE_IDS.has(spec.id)) continue; // 已知无映射：显式跳过（非静默）
    const r = roundtripIR(nodeSample(spec.id));
    if (!r.ok) {
      failures.push(`【${spec.id}】${r.diff ?? ''}\n===== 生成码 =====\n${r.code ?? ''}`);
      continue;
    }
    try {
      noDiags(parseScriptToIR(r.code ?? '').diagnostics);
      await assertTranspiles(r.code ?? '');
    } catch (err) {
      failures.push(`【${spec.id}】${err instanceof Error ? err.message : String(err)}`);
    }
  }
  assert.deepEqual(failures, [], `以下节点样本 roundtrip 失败：\n${failures.join('\n----------\n')}`);

  // 计数恒等式（防新节点静默漏测的硬门禁）
  assert.equal(audit.total, builtinSpecs.length, '审计总数应等于 builtinSpecs 长度');
  assert.equal(
    audit.tested.length + audit.skipped.length,
    audit.total,
    '计数恒等式不成立：总数 = 已测数 + 已知跳过数（新节点必须补样例入库或登记跳过清单）',
  );
  assert.equal(audit.skipped.length, KNOWN_UNMAPPED_NODE_IDS.size, '跳过数应等于已知无映射清单条目数');
});

test('TA.1 门禁 ①b：计数守卫自检（跳过清单漏记 / 新节点未入库 → 审计必红）', () => {
  // 模拟一：手动从跳过清单删掉一项（不真改文件，用副本模拟）→ 该节点应被判 missing（红灯）
  const shrunk = new Set([...KNOWN_UNMAPPED_NODE_IDS].slice(1));
  const afterShrink = auditCoverage(builtinSpecs, shrunk);
  assert.equal(afterShrink.missing.length, 1, '跳过清单漏记一项时，审计应恰好报出 1 个 missing');
  assert.ok(
    [...KNOWN_UNMAPPED_NODE_IDS].includes(afterShrink.missing[0] ?? ''),
    `missing 应为被删掉的清单条目，实际：${afterShrink.missing.join(', ')}`,
  );
  assert.notEqual(
    afterShrink.tested.length + afterShrink.skipped.length,
    afterShrink.total,
    '漏记时计数恒等式应被打破（tested + skipped < total）→ 门禁红灯',
  );

  // 模拟二：假想新增一个执行节点（未补样本、未进跳过清单）→ missing 应包含它（红灯）
  const ghostSpec = { id: 'flow.ghostNode' };
  const withGhost = auditCoverage([...builtinSpecs, ghostSpec], KNOWN_UNMAPPED_NODE_IDS);
  assert.ok(withGhost.missing.includes('flow.ghostNode'), '假想新节点未入库时审计应报 missing');
  assert.equal(withGhost.total, builtinSpecs.length + 1);

  // 模拟三：新节点入库（登记跳过清单，或有样本）→ 恢复绿（恒等式重新成立）
  const withGhostRegistered = auditCoverage(
    [...builtinSpecs, ghostSpec],
    new Set([...KNOWN_UNMAPPED_NODE_IDS, 'flow.ghostNode']),
  );
  assert.deepEqual(withGhostRegistered.missing, [], '新节点登记跳过清单后 missing 应清空');
  assert.equal(
    withGhostRegistered.tested.length + withGhostRegistered.skipped.length,
    withGhostRegistered.total,
    '登记后计数恒等式应恢复成立',
  );
});

/* ============================================================
 * 门禁 ②：真实资产样本（templates/log-analyzer，含片段演化）
 * ============================================================ */

test('TA.1 门禁 ②：真实资产样本 roundtrip（log-analyzer 模板 + 片段演化）+ .bp.json 序列化幂等', async () => {
  const targets = roundtripSamples.filter((s) => s.kind === 'asset');
  assert.equal(targets.length, 2, '应有 2 条真实资产样本（原始 + 片段演化）');
  for (const s of targets) {
    const r = roundtripIR(s.build());
    assert.equal(r.ok, true, `样本 ${s.name} roundtrip 失败：${r.diff ?? ''}\n===== 生成码 =====\n${r.code ?? ''}`);
    noDiags(parseScriptToIR(r.code ?? '').diagnostics);
    await assertTranspiles(r.code ?? '');
  }
  // 保存链路同源：.bp.json 序列化幂等（serializeIR ∘ deserializeIR 为恒等（规范形上））
  const raw = roundtripSamples.find((s) => s.name === 'asset:log-analyzer-template')!.build();
  const once = serializeIR(raw);
  assert.equal(serializeIR(deserializeIR(once)), once, 'serializeIR 应在规范形上幂等');
});

/* ============================================================
 * 门禁 ③：业务场景样本 + 片段节点专项样本（DoD：往返包含片段节点）
 * ============================================================ */

test('TA.1 门禁 ③：业务场景样本（条件循环/日志管线/字符串链/全特性）+ 片段专项 roundtrip', async () => {
  const targets = roundtripSamples.filter((s) => s.kind === 'scenario' || s.kind === 'snippet');
  assert.ok(targets.length >= 5, `场景 + 片段样本应不少于 5 条，实际 ${targets.length}`);
  for (const s of targets) {
    const r = roundtripIR(s.build());
    assert.equal(r.ok, true, `样本 ${s.name} roundtrip 失败：${r.diff ?? ''}\n===== 生成码 =====\n${r.code ?? ''}`);
    noDiags(parseScriptToIR(r.code ?? '').diagnostics);
    await assertTranspiles(r.code ?? '');
  }
});

/* ============================================================
 * 门禁 ④：全部样本幂等二次验证
 * ============================================================ */

test('TA.1 门禁 ④：全部样本幂等二次验证（roundtrip 输出再跑一轮 codegen→parse 仍等价）', async () => {
  assert.ok(roundtripSamples.length >= 70, `样本注册表应不少于 70 条，实际 ${roundtripSamples.length}`);
  for (const s of roundtripSamples) {
    const r = roundtripIR(s.build());
    assert.equal(r.ok, true, `样本 ${s.name} roundtrip 失败：${r.diff ?? ''}`);
    // 显式二次复核（roundtripIR 内部已含二次验证，此处独立重放以锁定门禁语义）
    const again = r.again!;
    const code2 = codegenTS(again);
    const parsed2 = parseScriptToIR(code2).asset;
    assert.deepStrictEqual(
      canonicalIR(parsed2),
      canonicalIR(again),
      `样本 ${s.name} 二次幂等破坏（roundtrip 输出再生成后再解析与首轮不一致）`,
    );
    await assertTranspiles(code2);
  }
});
