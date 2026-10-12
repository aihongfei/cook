import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/stores/auth'
import { apiClient } from './client'

export type FamilyRole = 'OWNER' | 'COOK' | 'EATER'

export interface FamilyMember {
  userId: string
  nickname: string
  avatar: string
  role: FamilyRole
  joinedAt: string
  /** 是不是"我"（由后端标记，前端不做 id 比对） */
  isMe: boolean
}

export interface Family {
  id: string
  name: string
  shared: boolean
  inviteCode: string
  createdAt: string
  memberCount: number
  memberLimit: number
  myRole: FamilyRole
  /** 我能做什么：能力表只在后端定义，前端**不硬编码权限**（D-021） */
  myCapabilities: string[]
  members: FamilyMember[]
}

export interface FamilyOptions {
  roles: { value: FamilyRole; label: string; capabilities: string[] }[]
  memberLimit: number
}

/** 能力常量只是给前端读代码方便，真正的判定始终用后端下发的 myCapabilities */
export const CAPABILITY = {
  ORDER_CREATE: 'order.create',
  MENU_MANAGE: 'menu.manage',
  MENU_CONFIRM: 'menu.confirm',
  MEMBER_MANAGE: 'member.manage',
  INVITE_RESET: 'invite.reset',
  FAMILY_EDIT: 'family.edit',
} as const

/** 我有没有某项能力（没加入家庭一律视为没有） */
export function can(family: Family | null | undefined, capability: string): boolean {
  return Boolean(family?.myCapabilities?.includes(capability))
}

export async function fetchFamily(): Promise<Family | null> {
  const { data } = await apiClient.get<Family | null>('/family')
  return data
}

export async function createFamily(input: { name?: string }): Promise<Family> {
  const { data } = await apiClient.post<Family>('/family', input)
  return data
}

export async function joinFamily(inviteCode: string): Promise<Family> {
  const { data } = await apiClient.post<Family>('/family/join', { inviteCode })
  return data
}

export async function updateFamily(input: { name?: string; shared?: boolean }): Promise<Family> {
  const { data } = await apiClient.patch<Family>('/family', input)
  return data
}

export async function resetInviteCode(): Promise<Family> {
  const { data } = await apiClient.post<Family>('/family/invite/reset')
  return data
}

export async function updateMemberRole(userId: string, role: FamilyRole): Promise<Family> {
  const { data } = await apiClient.patch<Family>(`/family/members/${encodeURIComponent(userId)}`, { role })
  return data
}

export async function removeMember(userId: string): Promise<Family> {
  const { data } = await apiClient.delete<Family>(`/family/members/${encodeURIComponent(userId)}`)
  return data
}

export async function leaveFamily(): Promise<{ left: true; disbanded: boolean }> {
  const { data } = await apiClient.post<{ left: true; disbanded: boolean }>('/family/leave')
  return data
}

export async function fetchFamilyOptions(): Promise<FamilyOptions> {
  const { data } = await apiClient.get<FamilyOptions>('/family/options')
  return data
}

export function useFamily() {
  const token = useAuth((state) => state.token)
  return useQuery({
    queryKey: ['family'],
    queryFn: fetchFamily,
    enabled: Boolean(token),
    staleTime: 30_000,
  })
}

export function useFamilyOptions() {
  return useQuery({ queryKey: ['family', 'options'], queryFn: fetchFamilyOptions, staleTime: 60 * 60_000 })
}

/** 所有会改变家庭状态的接口都返回最新家庭，直接写回缓存，省一次往返 */
function useFamilyMutation<TInput>(mutationFn: (input: TInput) => Promise<Family>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSuccess: (family) => queryClient.setQueryData(['family'], family),
  })
}

export const useCreateFamily = () => useFamilyMutation(createFamily)
export const useJoinFamily = () => useFamilyMutation((inviteCode: string) => joinFamily(inviteCode))
export const useUpdateFamily = () => useFamilyMutation(updateFamily)
export const useResetInviteCode = () => useFamilyMutation(() => resetInviteCode())
export const useUpdateMemberRole = () => useFamilyMutation((input: { userId: string; role: FamilyRole }) => updateMemberRole(input.userId, input.role))
export const useRemoveMember = () => useFamilyMutation((userId: string) => removeMember(userId))

export function useLeaveFamily() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: leaveFamily,
    onSuccess: () => queryClient.setQueryData(['family'], null),
  })
}
