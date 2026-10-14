import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

/**
 * 「我做过」（M9 / F9-01）。口径见 D-075。
 *
 * **它是什么**：我点过、且那一餐已经标成「做好了」的菜，带做过几次与最近一次做的日期。
 * 用户要的这句 —— 「家庭任何人都可以点击做好，但**要记录是谁点的，谁点的就是谁掌勺的**」
 * —— 落在数据上就是这样：`OrderItem.userId` 早就是点菜人（不需要新字段），
 * 我把某道菜点进菜单、那一餐又做掉了，我这儿就算"做过这道"。
 *
 * **与「家人最爱」的区别**：那一份是家庭口径（"我们家做过 3 次"、按分数排），
 * 这一份**只算我自己点的**、按最近做的排——它是"我的手艺账本"，不是家里的榜单。
 * 所以它**不受共享开关影响**：那个开关管"家人之间互相可见"，而看自己的记录不需要别人允许。
 */

export interface CookedDish {
  id: string
  name: string
  image: string | null
  category: string
  cuisine: string
  tags: string[]
  calories: number | null
  caloriesEstimated: boolean
  /** 做过几次（**按餐去重**：同一餐里点了两份只算一次） */
  cooked: number
  /** 最近一次做的日期（`YYYY-MM-DD`） */
  lastCookedOn: string | null
  /**
   * 那行字（"做过 3 次 · 最近 3 天前"）——**后端拼好**，前端只渲染。
   * 与采购清单的 `stockLabel`、冰箱的 `addedLabel` 同一条规矩（D-059 四）。
   */
  cookedLabel: string
}

export interface CookedBoard {
  items: CookedDish[]
  /** 我做过的菜一共多少道（不是返回了多少道）——界面据此说"还有 N 道" */
  total: number
  limit: number
}

export async function fetchCooked(limit?: number): Promise<CookedBoard> {
  const { data } = await apiClient.get<CookedBoard>('/discover/cooked', {
    params: limit ? { limit } : undefined,
  })
  return data
}

export function useCooked(limit?: number) {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['discover', 'cooked', limit ?? 0],
    queryFn: () => fetchCooked(limit),
    enabled: Boolean(token),
    staleTime: 30_000,
  })
}
