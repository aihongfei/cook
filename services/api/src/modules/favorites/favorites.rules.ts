import { BadRequestException } from '@nestjs/common'

/**
 * 收藏的纯规则（M1 / F1-09）。口径见 D-037。
 *
 * 与其他 `*.rules.ts` 同一套路：**不碰数据库的判定都放这里**，单测直接验。
 * 收藏本身很简单（是/不是），但有两个"以后一定会问"的点值得钉死：
 * 收藏是**按人**还是按家、以及一个人最多能收藏多少。
 */

/**
 * 一个人最多收藏多少道。
 *
 * 上限不是为了省资源（家庭用户的收藏量根本到不了），而是**防止界面变成一个没有出口的列表**：
 * 收藏页一屏能扫过去才有用，攒到几百条时它和"全库浏览"就没区别了。
 * 到上限时的处置是**明确拒绝**（不悄悄顶掉最早的）：静默删掉用户更早收藏的那道，
 * 而他下次找不到，只会以为收藏功能坏了。
 */
export const FAVORITES_MAX = 200

/** 菜谱 id：非空字符串。真正"这道菜存在吗"由服务层查库确认（规则层不碰数据库） */
export function parseRecipeId(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('菜谱 id 要写成文字')
  const id = raw.trim()
  if (!id) throw new BadRequestException('菜谱 id 不能为空')
  if (id.length > 64) throw new BadRequestException('菜谱 id 太长')
  return id
}

/**
 * 还能不能再收一道：已到上限就拒绝，并说清楚"要收藏新的先取消一道"。
 *
 * `already` 为真时**永远放行**——那是一次重复收藏（切换语义），不是新增一条。
 * 少了这个判断，收藏到上限的人连"取消收藏"都做不了（点一下想取消，先被上限拦下）。
 */
export function canFavorite(count: number, already: boolean): boolean {
  return already || count < FAVORITES_MAX
}
