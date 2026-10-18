/**
 * 项目/全局函数签名缓存（v3 T12.2/T12.9）
 *
 * 画布的动态引脚渲染需要外部函数（.fn.json）的 params/returns。函数检索面板加载
 * 清单时顺带读取签名写入本缓存；模型层据此给 flow.call 渲染数据引脚。
 */
import type { IRParamSpec } from '@/ir/types'

export interface FunctionSignature {
  params: IRParamSpec[]
  returns: IRParamSpec[]
}

const signatures = new Map<string, FunctionSignature>()

export function signatureKey(scope: 'project' | 'global', name: string): string {
  return `${scope}:${name}`
}

export function setFunctionSignature(
  scope: 'project' | 'global',
  name: string,
  sig: FunctionSignature,
): void {
  signatures.set(signatureKey(scope, name), sig)
}

export function getFunctionSignature(
  scope: 'project' | 'global',
  name: string,
): FunctionSignature | undefined {
  return signatures.get(signatureKey(scope, name))
}

export function clearFunctionSignatures(): void {
  signatures.clear()
}
