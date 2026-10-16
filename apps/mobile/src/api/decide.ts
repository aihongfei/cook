import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from './client'

/**
 * 「帮我决定」（M5 / F5-05）。口径见 D-060。
 *
 * 与「摇一道」的区别不是"随机不随机"，是**知不知道自己家**：这条要把冰箱（M6）、
 * 口味档案（M8）、家人的做过/收藏（F5-02）一起看进来，然后**只给一道、不让用户挑**。
 *
 * 用 `useMutation` 而不是 `useQuery` 就体现了这件事：这不是"取一份数据"，是
 * **点一下要一个主意**。用 query 的话每次进入页面都会自动问一遍（还有一个"上一次的答案"
 * 挂在缓存里），而用户点新的一次时应该是一次新的决定。
 */

export interface DecideDish {
  id: string
  name: string
  image: string | null
  category: string | null
  cuisine: string | null
  calories: number | null
  caloriesEstimated: boolean
  /** 用上了冰箱里的哪几样（**按用户自己的说法**回显） */
  have: string[]
  /** 还差哪几样：**列名字**——用户要拿它决定顺不顺路买 */
  missing: string[]
  cooked: number
  favorites: number
}

export interface DecideResult {
  scope: 'family' | 'mine'
  /**
   * 一句话说清为什么是这道（**后端拼好**，前端只照搬）。
   *
   * 与采购清单那句"家里有 半盒，够不够看一眼"同一条规矩（D-059 四）：两边各拼一遍
   * 必然漂移，而"为什么推荐这道"和它一样，用户会拿它判断要不要信。
   */
  reason: string | null
  /** 冰箱里一条都没记：界面要说"记了冰箱才能照着冰箱挑"，否则用户不知道它凭什么选 */
  fridgeEmpty: boolean
  /** 这一轮还能不能接着换（只有一个候选时为 false，「换一道」据此置灰） */
  canSwap: boolean
  /** `null` = 拿不出菜（空库、或口味档案排掉了全部），此时 `reason` 是原因 */
  recipe: DecideDish | null
  /** 这一次是按哪个场合挑的（`null` = 没要求）。2026-10-16 加的「换个场合挑」 */
  occasion?: string | null
  /** 那个场合的三个字（"来客人了"）——后端给，前端不查表 */
  occasionLabel?: string | null
}

export async function fetchDecide(exclude: string[] = [], signal?: AbortSignal): Promise<DecideResult> {
  const { data } = await apiClient.get<DecideResult>('/discover/decide', {
    params: { exclude: exclude.length ? exclude.join(',') : undefined },
    signal,
  })
  return data
}

/**
 * 「换个场合挑」（2026-10-16）：带着一个场合标签**重问一次**「帮我决定」。
 *
 * 与 `useDecide` 同一个接口，但**不复用它的 mutation**：那个的结果存在
 * `stores/today-session` 里，为的是"点菜名进详情再返回时那道菜原样还在"（用户 2026-10-13
 * 的原话"保持原样"）。而这一条是抽屉里的一个小工具——点一下「来客人了」就是想换一道，
 * 结果只属于当前这一次点击，不该写进那个 store（写进去会污染"返回时原样"的语义）。
 */
export function useDecideForOccasion() {
  return useMutation({
    mutationFn: async ({ occasion, exclude }: { occasion: string; exclude: string[] }) => {
      const { data } = await apiClient.get<DecideResult>('/discover/decide', {
        params: {
          occasion,
          exclude: exclude.length ? exclude.join(',') : undefined,
        },
      })
      return data
    },
  })
}

/**
 * 「换一道」把已经看过的排除掉（`exclude`），否则可能换回同一道——连点两次看到同一道菜，
 * 用户只会认为按钮坏了。
 */
export function useDecide() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (exclude: string[]) => fetchDecide(exclude),
    /*
     * 成功后把「家人最爱」作废：用户可能刚从"帮我决定"里点了一道进菜单，
     * 而那道菜一旦被做好，榜单会变（与 AI 写库后的作废同一条理由，见 D-054）。
     * 这里不主动改那份缓存——我们只知道"用户看了这道"，不知道他点没点。
     */
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['discover', 'family-picks'] })
    },
  })
}
