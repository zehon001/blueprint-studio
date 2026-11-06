/**
 * Blueprint Studio v2 —— 脚本内建全局「类型声明可用」的编译期证明样例（T3.2）
 *
 * 受控子集风格的样例，引用内建全局（vars/emit/onEvent/plugins/print/convert/
 * format/delay/readFile）。本文件正常参与 tsc typecheck：`npm run typecheck` 通过即证明
 * types.d.ts 的 declare global 对普通模块可见、类型与补全体验成立。
 * 不被任何入口 import，不参与构建产物。
 */
import type { LogRow } from './types';

/** 读取手机日志并刷新列表（PLAN §9.2 LogViewer 示意的类型可编译版） */
export async function fetchLogs(packageName: string): Promise<void> {
  // vars —— 基础读写 + Object.keys
  vars.packageName = packageName;
  const pkg: string = String(vars.packageName ?? '');

  // plugins —— 插件调用（await；返回 unknown 需收敛）
  const lines = (await plugins.phoneLog.read({ mode: 'adb', filter: pkg })) as string[];

  // convert —— 全部 8 个函数（与转换节点同语义）
  const rows: LogRow[] = convert.androidLogParse(lines);
  vars.lastCount = rows.length;
  const count: number = convert.toNumber(vars.lastCount);
  const n: number = convert.parseInt('12abc');
  const flag: boolean = convert.toBool('yes');
  const label: string = convert.toString(rows.length);
  const cfg: unknown = convert.jsonParse('{"autoScroll":true}');
  const dump: string = convert.jsonStringify(rows);
  const stamp: string = convert.timeFormat(Date.now(), 'YYYY-MM-DD HH:mm:SS');
  vars.config = cfg;
  vars.dump = dump;

  // format —— {0} {1}… 占位符，缺参空串
  const summary = format('共 {0} 行 · {1}', count, stamp);

  // emit / onEvent —— 自定义事件收发（@on / 发送事件节点的运行时形态）
  onEvent('refresh', (args) => {
    print('刷新', args, label);
    emit('refreshed', rows.length);
  });
  emit('loaded', { count, from: pkg, debug: n === 12 && flag });

  // delay —— 异步延时不阻塞其他事件队列
  await delay(500);

  print(summary, Object.keys(vars).length);
}
