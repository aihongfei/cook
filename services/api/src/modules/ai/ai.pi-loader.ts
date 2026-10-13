/**
 * pi-ai 的 ESM 加载桥（D-042/D-044）。
 *
 * 为什么需要它：`@earendil-works/pi-ai` 是 **ESM-only**（package.json 的 exports 里只有
 * `import` 条件），而本项目后端以 CommonJS 产出（`module: "commonjs"`）。两条直路都堵：
 * - `require('@earendil-works/pi-ai')` → `ERR_PACKAGE_PATH_NOT_EXPORTED`；
 * - 源码里写 `await import(...)` → TypeScript 的 commonjs 目标会把它**降级成 `require`**
 *   （编译产物实测），运行时同样报上面那个错。
 *
 * 所以这里用 `new Function('specifier', 'return import(specifier)')` 把动态 import
 * **藏过编译器**：TS 看不到里面的 import 语法、原样保留字符串，运行时才是真正的 ESM 动态导入
 * （Node ≥ 22 的 import() 在 CJS 里完全合法）。这是**唯一**一处需要这样绕的地方，
 * 类型安全不受影响：模块类型用 `typeof import(...)` 从真实声明推导。
 *
 * 两个刻意的选择：
 * - **懒加载**：只有真正要调用 AI 时才加载（进程启动、跑单测、健康检查都不需要它）；
 *   加载失败只影响 AI 功能，不会让整个服务起不来。
 * - **缓存 Promise**：并发调用只加载一次（ESM 模块本身也有缓存，这里省掉重复等待）。
 */
import type { ProviderStreams } from '@earendil-works/pi-ai'

/** 根模块的类型（从真实声明推导，不手抄签名） */
export type PiAiModule = typeof import('@earendil-works/pi-ai')

/** 子路径模块 `api/openai-completions.lazy` 的形状：适配器工厂 */
export interface PiOpenAiCompletionsModule {
  openAICompletionsApi: () => ProviderStreams
}

/** 见文件头：绕过 TS 的 require 降级，保留真正的动态 import */
const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

let rootPromise: Promise<PiAiModule> | undefined
let completionsPromise: Promise<PiOpenAiCompletionsModule> | undefined

export function loadPiAi(): Promise<PiAiModule> {
  rootPromise ??= dynamicImport('@earendil-works/pi-ai') as Promise<PiAiModule>
  return rootPromise
}

export function loadOpenAiCompletions(): Promise<PiOpenAiCompletionsModule> {
  // 用 .lazy 子路径：适配器实现（连同 openai SDK 等）在**第一次调用**时才真正加载，
  // 与我们只想在用时付加载代价的取向一致
  completionsPromise ??= dynamicImport(
    '@earendil-works/pi-ai/api/openai-completions.lazy',
  ) as Promise<PiOpenAiCompletionsModule>
  return completionsPromise
}
