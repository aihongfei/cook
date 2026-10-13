/**
 * 运行时装配（D-044）：把用户配置变成一个"可以发请求的 pi-ai models 实例"。
 *
 * 为什么单独一个文件而不是写在 ai.client 里：ESM 桥（ai.pi-loader）与业务客户端之间
 * 隔一层"把配置翻成 pi-ai 对象"的装配，**这层不碰网络、也不碰 Nest**，可以单独读、单独测。
 *
 * 三个刻意的选择：
 * - **不用 pi-ai 的凭据存储与环境变量**：apiKey 由调用方从配置给（密钥只来自 `.env`，
 *   不进它可能落盘的位置）；provider/baseUrl 也现造，因为用户的模型名不一定是内置目录里的。
 * - **兼容性声明显式写死**（GATEWAY_COMPAT）：见那里的注释——自动探测认不出这台网关。
 * - **不用 `completeSimple`**：它会给 `options.maxTokens` 兜一个默认值，于是请求体里
 *   多一个 `max_completion_tokens`；迁移前是不发的，保持**逐字节一致**用 `models.stream`。
 */
import type { Models, Model } from '@earendil-works/pi-ai'
import type { AiConfig } from './ai.rules'
import { loadOpenAiCompletions, loadPiAi } from './ai.pi-loader'

/**
 * 这台网关（opencode.ai 的 go 网关）的兼容性声明。
 *
 * 每条都有实测依据（D-042）：
 * - `requiresReasoningContentOnAssistantMessages`：思维模式下网关要求回传
 *   `reasoning_content`（R-23 的 400 就是缺它），pi-ai 会给没有思维的助手消息补空串；
 * - `thinkingFormat: 'deepseek'`：思维内容走 `reasoning_content` 字段
 *   （内置目录里这个模型就是这两个值）；
 * - `supportsDeveloperRole: false`：实测该网关只认 `system` 角色（不写会被改成 developer）；
 * - `supportsStrictMode: false`：**保持迁移前的报文**——我们的工具 schema 一直是原样发的，
 *   由 pi-ai 默认不额外加 `strict`（与内置目录里的 `supportsStrictMode: true` 不同，
 *   那是给工具声明用的；我们这里的取值以"报文不变"为准）。
 */
const GATEWAY_COMPAT = {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
  supportsDeveloperRole: false,
} as const

const PROVIDER_ID = 'cook-gateway'

/** 一次调用要用的运行时（模型元数据 + 装配好的 models 实例） */
export interface PiRuntime {
  models: Models
  model: Model<'openai-completions'>
}

/**
 * pi-ai 要求每个 provider 都声明 auth，连"不需要密钥"的本地服务也不例外。
 *
 * 这里用的是它文档里的**无密钥写法**（`resolve` 回一个空 auth）：本项目**不**让它从
 * 凭据存储或环境变量里找密钥，而是每次调用在 `options.apiKey` 里显式给（见 ai.client）
 * ——密钥只来自 `.env`，不落到它可能持久化的位置。
 */
const KEYLESS_AUTH = { apiKey: { name: 'cook', resolve: async () => ({ auth: {} }) } } as const

/**
 * 造一次调用用的运行时。
 *
 * 每次调用都现造一个 models 实例：它只是一张"provider → 适配器"的表，构造成本极低，
 * 换来的是**天然的隔离**（不同调用的配置、头、信号不会互相串）。
 */
export async function createRuntime(config: AiConfig): Promise<PiRuntime> {
  // 这两个模块都必须是**运行时**加载：`import { createModels } from '@earendil-works/pi-ai'`
  // 会被 TS 编译成 require，在 ESM-only 的包上直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`
  // （容器里实测踩过）。类型可以静态导入（编译后消失），值不行。
  const [{ createModels, createProvider }, { openAICompletionsApi }] = await Promise.all([
    loadPiAi(),
    loadOpenAiCompletions(),
  ])

  const model: Model<'openai-completions'> = {
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: PROVIDER_ID,
    baseUrl: config.baseUrl,
    // 这个模型支持图片（内置目录里它的 input 就是 ['text','image']，2026-10-13 实测收图）
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_000,
    // off=null：**不传** thinking 参数（迁移前就是什么都不传，行为保持一致）
    thinkingLevelMap: { off: null },
    compat: GATEWAY_COMPAT,
  }

  const models = createModels()
  models.setProvider(createProvider({
    id: PROVIDER_ID,
    name: 'cook',
    baseUrl: config.baseUrl,
    auth: KEYLESS_AUTH,
    models: [model],
    api: openAICompletionsApi(),
  }))

  return { models, model }
}

/** 这个网关强制要的模型标识（构造助手消息时必填） */
export const PI_IDENTITY = { provider: PROVIDER_ID } as const
