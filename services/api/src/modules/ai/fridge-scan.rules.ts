/**
 * 冰箱拍照识别的**纯规则**（F16-04）。
 *
 * 流程：用户拍一张冰箱/食材的照片 → 模型看图给出食材清单（名字、大概数量、推断的存放区）
 * → **用户逐项确认校正后**才批量入库。
 *
 * 为什么"必须逐项确认"而不是直接入库（这是这块最重要的决定）：
 * 照片识别**一定会认错**——塑料袋里的东西、叠在一起的盒子、反光的包装。直接入库的后果
 * 不是"多了一条错的"那么轻：冰箱是"今日先吃"与推荐的输入，错一条会让用户照着过期的做菜；
 * 而用户对"AI 看一眼就写进去了"的容忍度极低（他会觉得冰箱被弄脏了，然后再也不信这个功能）。
 * 所以这里的产物**永远是草稿**，写库那一步走用户自己那条 `/fridge`（与手填同一个口）。
 *
 * 三个字段的处理**刻意不同**，这是本节的核心：
 * - **名字**：模型给什么就用什么（但要去空、限长、去重）。它是唯一必填的。
 * - **数量**：模型常给出"一盒""半颗"这种词，也可能编一个具体数（"约 500g"）。
 *   照原样放进去、让用户改——但**不许它编日期**（见下一条）。
 *
 * ⚠️ **备注也是一条静默通道**（2026-10-13 实测抓到的）：模型很爱把"灰色蛋托中可见六枚"
 * 这种**描述**写进 `note`，而界面上备注栏曾经不显示——于是它悄悄跟着入库了。
 * 两处都堵上：提示词明确"备注只写包装上读得到的字，没有就留空"，界面上备注也摆出来能改
 * （**用户没看过的字段不该被写进库**，这正是"逐项确认"的意思）。
 * - **存放区**：模型按常识推断（鸡蛋→冷藏、土豆→常温）。**只接受四区之一**，
 *   不认的一律落到"冷藏"（冰箱里最多的就是冷藏）而不是整个丢掉，同时**标出来是猜的**。
 * - **保质期**：**一律不填**。让模型看图猜"这盒奶哪天过期"是在编数据——它连今天是几号
 *   都可能算错，而这个值直接驱动"今日先吃"。用户想写就自己写（他已经养成这个习惯了）。
 */

import { BadRequestException } from '@nestjs/common'
import { FRIDGE_AMOUNT_MAX, FRIDGE_NAME_MAX, FRIDGE_NOTE_MAX, FRIDGE_ZONES, type FridgeZone } from '../fridge/fridge.rules'
import { extractJsonObject } from './ai.rules'

/** 一次最多认几样：再多用户要核对到烦，而且照片里也放不下 */
export const OCR_MAX_ITEMS = 20

/** 每条备注的上限（与冰箱同一套口径） */
const NOTE_MAX = FRIDGE_NOTE_MAX

/** 模型直接给的名字超过这个长度就是它在胡说（不是食材名） */
const RAW_NAME_MAX = 60

/**
 * 一条识别结果（**草稿，还没入库**）。
 *
 * `zoneGuessed` 是给界面用的：它要告诉用户"这个区是猜的"，用户才会去改。
 * 不标的话，猜错的区会安安静静地待在那儿——而四区是 3D 摆放与"在哪儿"的依据。
 */
export interface FridgeScanItem {
  name: string
  amount: string | null
  zone: FridgeZone
  /** 这个存放区是模型推断的（不是照片里读出来的），界面上标一下 */
  zoneGuessed: boolean
  note: string | null
}

export interface FridgeScanResult {
  items: FridgeScanItem[]
  /** 模型对这张照片的一句总体判断（"上层两盒奶、下层一袋青菜"），给用户核对用 */
  summary: string
}

/**
 * 从模型的回包里解析识别结果。
 *
 * **不能整体失败**：模型给 8 条里有 2 条没名字，丢掉那 2 条、留住 6 条——
 * 用户看到 6 条能用的，比看到一句"识别失败"要好得多（后者等于让他重新拍一张，
 * 而照片可能是在超市冷柜前拍的，重拍不了）。
 *
 * 但也不能**什么都收**：名字为空/不是字符串的一律丢；名字长到 60 字以上的丢；
 * 数量与备注按冰箱的上限截断；区不认识就落到"冷藏"并标记是猜的。
 */
export function parseFridgeScan(text: string): FridgeScanResult {
  const parsed = extractJsonObject(text)
  if (!parsed) throw new BadRequestException('AI 没认出这张照片里的东西，换一张清楚点的试试')

  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 120) : ''
  const rawItems = Array.isArray(parsed.items) ? parsed.items : []
  const items: FridgeScanItem[] = []
  const seen = new Set<string>()

  for (const raw of rawItems) {
    const row = (raw ?? {}) as { name?: unknown; amount?: unknown; zone?: unknown; note?: unknown }
    const name = typeof row.name === 'string' ? row.name.trim().replace(/\s+/g, ' ') : ''
    if (!name || name.length > RAW_NAME_MAX) continue
    // 去重按**归一后的名字**：模型常把同一样东西写两遍（"牛奶"与"一盒牛奶"算两条不划算，
    // 但那种归一交给用户旁边的下拉框，这里只去掉完全同名的）
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    const zone = pickZone(row.zone)
    items.push({
      name: name.slice(0, FRIDGE_NAME_MAX),
      amount: optionalText(row.amount, FRIDGE_AMOUNT_MAX),
      zone: zone.value,
      zoneGuessed: zone.guessed,
      note: optionalText(row.note, NOTE_MAX),
    })
    if (items.length >= OCR_MAX_ITEMS) break
  }

  return { items, summary }
}

/**
 * 存放区：认识的直接用，不认识或没给就落"冷藏"并**标记为猜的**。
 *
 * 为什么兜底是冷藏而不是拒绝：模型十次里有几次会写"冰箱里""保鲜层"这种词，
 * 为这个把一条食材整个丢掉是亏的——**冷藏本来也是冰箱里最常用的一格**，
 * 而界面上会标"冷藏（猜的）"，用户扫一眼就能改。
 */
function pickZone(raw: unknown): { value: FridgeZone; guessed: boolean } {
  const value = typeof raw === 'string' ? raw.trim() : ''
  if ((FRIDGE_ZONES as readonly string[]).includes(value)) return { value: value as FridgeZone, guessed: false }
  return { value: '冷藏', guessed: true }
}

/** 一段可选文本：空/非字符串给 null，超长截断（不报错——识别结果不该因为一个字太多就让整张照片报废） */
function optionalText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return value ? value.slice(0, max) : null
}

/**
 * 识别用的提示词。
 *
 * 三条刻意的：
 * - **明确说"看不清的不要猜"**：模型很乐意把一团模糊的东西说成"猪肉"，
 *   而用户扫一眼清单时会默认"AI 看到的都在里面"——多一条假的比少一条真的更糟。
 * - **明确不许给保质期**：它看不到日期，问它就是逼它编（见文件头）。
 * - **数量要照原样**：写"一盒"而不是"约 400g"——后者是估重，用户没法核对。
 */
export const FRIDGE_SCAN_PROMPT = [
  '这是一张家庭冰箱或食材的照片。请列出你能**清楚辨认**的食材。',
  '',
  '严格要求：',
  '1. **看不清、认不准的东西一律不要写**——宁可少写几样，也不要猜。',
  '2. 不要编造保质期（照片里看不到生产日期，一律不写这一项）。',
  '3. 数量只写**数目与单位**（"一盒""半颗""两袋""6 枚"）；读不出具体数量就留空。',
  '   不要写颜色、外观、位置、状态这类描述——用户要的是"有几样"，不是复述照片。',
  '4. 备注只写包装上**读得到的字**（品牌、口味、规格）；没有就留空，不要描述外观。',
  '5. 存放区按常识给（常温 / 保鲜 / 冷藏 / 冷冻），拿不准就给"冷藏"。',
  '6. 最多 20 样。',
  '',
  '只输出 JSON，不要写别的：',
  '{"summary":"一句话说这张照片里大概有什么","items":[{"name":"食材名","amount":"一盒","zone":"冷藏","note":""}]}',
].join('\n')

/**
 * 冰箱识别用的 JSON Schema（结构化输出）。
 *
 * 与推荐那份同一个教训（见 ai.rules 的 `PROMPTS_SCHEMA` 注释）：**每条结构化请求都要带
 * 自己的 schema**——用错的那份会让模型被强制返回别的形状，解析必然失败而功能静默失效。
 *
 * `strict` + `additionalProperties:false`：字段就这四个，让模型没机会自由发挥。
 * `required` 里**只有 name**：数量/存放区/备注都可以缺（缺了 users 更要紧的是"这道菜在不在"），
 * 强制 required 会逼模型为"看不清数量"编一个值，而那正是我们最不想要的。
 */
export const FRIDGE_SCAN_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'fridge_scan',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              amount: { type: 'string' },
              zone: { type: 'string', enum: [...FRIDGE_ZONES] },
              note: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'items'],
      additionalProperties: false,
    },
  },
} as const
