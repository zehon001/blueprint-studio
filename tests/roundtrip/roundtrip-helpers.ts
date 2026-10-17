/**
 * Blueprint Studio v2 —— TA.1 roundtrip 幂等测试框架：共享助手（单源 re-export）
 *
 * 本文件【不实现任何比较逻辑】：全部工具原样 re-export 自基座
 * `src/script/roundtrip.test.ts`（T3.5/T3.6/T3.7 交付），保证「比较器 / 样本构造器
 * 只有一份实现」。若需修改比较规则（canonicalIR / roundtripIR / firstDiff），请改
 * 基座文件 —— 本目录与基座套件（`npx tsx --test src/script/roundtrip.test.ts`）会同时生效。
 *
 * 导出分组：
 *  - 比较器：roundtripIR（IR→TS→IR 幂等比较 + 二次验证）、canonicalIR（确定性规范化
 *    规范形）、firstDiff（首差异路径定位）、RoundtripResult（结果类型）；
 *  - 样本构造：asset / graph / node / execEdge / dataEdge（IRAsset 构造糖）、
 *    pureNodeSample（纯节点逐条样本构造器，引脚取 spec 默认值 / 字面量）；
 *  - 场景样本：fullFeatureAsset（全特性）/ counterAsset（条件循环）/ logPipelineAsset
 *    （日志管线）/ stringChainAsset（字符串链）/ multiSnippetAsset（多片段引脚重建）；
 *  - 断言助手：assertRoundtrip（roundtrip + 零诊断 + 可转译）、noDiags、assertTranspiles。
 *
 * 注意：re-export 自测试文件意味着运行本目录任一 *.test.ts 时，基座的 18 个测试
 * 也会同进程注册执行（node:test 行为）——它们全绿，且构成对比较器本身的持续回归。
 */
export {
  /* ---------- 比较器（规范形比较规则的唯一实现，见基座文件头注释） ---------- */
  roundtripIR,
  canonicalIR,
  firstDiff,
  type RoundtripResult,
  /* ---------- 样本构造糖 ---------- */
  asset,
  graph,
  node,
  execEdge,
  dataEdge,
  pureNodeSample,
  /* ---------- 场景样本（T3.5 / T3.6 / T3.7 基座） ---------- */
  fullFeatureAsset,
  counterAsset,
  logPipelineAsset,
  stringChainAsset,
  multiSnippetAsset,
  /* ---------- 断言助手 ---------- */
  assertRoundtrip,
  assertTranspiles,
  noDiags,
} from '../../src/script/roundtrip.test';
