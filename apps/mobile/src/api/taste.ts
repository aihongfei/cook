import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from './client'

/**
 * 口味与健康档案（M8 / F8-01、F8-02）。
 *
 * 一份档案**跟着人走**（一人一条），所以这里只有"我的"与"全家的"两个视角：
 * 谁的档案谁能改（"我对花生过敏"这件事只有本人说得准），而全家那份是只读的聚合。
 */

export interface TasteProfile {
  userId: string
  nickname: string
  avatar: string
  /** 能接受到哪一档辣（0 不吃辣 / 1 微辣 / 2 中辣 / 3 重辣）；null = 没说过（不限） */
  spicyLevel: number | null
  /** 口味偏好标签（清淡/少盐/偏甜…）。**只是给 AI 的偏好信号**，不做硬过滤 */
  flavors: string[]
  /** 荤素倾向；null = 没说过。同样只作偏好，不硬拦 */
  diet: string | null
  /** 过敏原。**硬拦**：推荐里排除、点菜时明确警告 */
  allergies: string[]
  /** 忌口/不爱吃。软提醒 */
  dislikes: string[]
  note: string | null
  /** 这条档案写过没有（全空 = 还没说过，界面上要说"他还没写"） */
  filled: boolean
  updatedAt: string | null
}

export interface TasteFamily {
  me: TasteProfile | null
  /** 全家每个人的档案（含**还没写的人**） */
  members: TasteProfile[]
  /**
   * 还没写档案的成员昵称。
   *
   * 由后端点名下发（而不是前端数一遍）：界面上要说「妈妈、爸爸还没写」——
   * 只回填过的那几条会让用户以为"全家都护上了"，而实际上可能只有他自己填了，
   * 家里那位对花生过敏的人根本没写，于是推荐照常推花生。
   */
  missing: string[]
}

export interface TasteOptions {
  spicyLevels: string[]
  diets: string[]
  allergies: string[]
  dislikes: string[]
  flavors: string[]
}

/** 可选项与建议词。**免登录也取**：空态就要能看见"原来可以写过敏" */
export function useTasteOptions() {
  return useQuery({
    queryKey: ['taste', 'options'],
    queryFn: async () => (await apiClient.get<TasteOptions>('/taste/options')).data,
    staleTime: Infinity,
  })
}

export function useTasteFamily(enabled = true) {
  return useQuery({
    queryKey: ['taste', 'family'],
    queryFn: async () => (await apiClient.get<TasteFamily>('/taste/family')).data,
    enabled,
  })
}

/** 改我自己的档案。**部分更新**：只传改动的字段，没传的不动 */
export function useUpdateTaste() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (patch: Partial<Pick<TasteProfile, 'spicyLevel' | 'flavors' | 'diet' | 'allergies' | 'dislikes' | 'note'>>) =>
      (await apiClient.patch<TasteProfile>('/taste', patch)).data,
    onSuccess: (data) => {
      // 自己的那份与全家那份是同一个数据的两个视角，一处改了另一处要跟着变
      queryClient.setQueryData(['taste', 'family'], (current: TasteFamily | undefined) => {
        if (!current) return current
        const members = current.members.map((item) => (item.userId === data.userId ? data : item))
        return { ...current, me: data, members, missing: current.missing.filter((name) => name !== data.nickname) }
      })
    },
  })
}
