import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { PrismaService } from './prisma.service'
import {
  ensureBucket, extensionForContentType, mediaKey, mediaS3Config, publicImageUrl, putImage, s3Client,
} from '../media/media.storage'
import { decodeImage } from '../media/image.rules'
import { NotificationsService } from '../notifications/notifications.service'
import {
  RECIPE_ORIGIN_USER,
  buildSearchText,
  canWriteRecipe,
  parseRecipeCreate,
  parseRecipePatch,
  sourceLabel,
  writeRefusal,
  type RecipeDraft,
} from './recipe.rules'
import type { Ingredient, RecipeSource } from './recipe.types'

/** 这一次请求里带没带配图（有它就给 `parseRecipePatch` 放行"别的字段都没改"那种情况） */
function imageProvided(raw: unknown): boolean {
  const image = (raw as { image?: unknown } | null)?.image
  return typeof image === 'string' && image !== ''
}

/**
 * 自建菜谱的写操作（F1-11 / F1-12；用户 2026-10-13：「自己上传的要和极速 api 的区分下」）。
 *
 * **为什么单独一个 service 而不是塞进 provider**：provider 是"读菜谱"的抽象
 * （可以换成别的数据源，见 `recipe.types` 的说明），而写只对**自家那份数据**有意义——
 * 第三方源抓来的菜写不进去，也不该写。两者混在一起会让 provider 的契约变得含糊
 * （"这个 provider 支不支持写？"）。
 *
 * **AI 也走这里**（见 ai.service 的菜谱工具）：一条写入逻辑只此一份，
 * 校验、家庭隔离、搜索文本拼法都只有一处实现。D-052 给冰箱定的规矩沿用到这里。
 *
 * 三处写操作**顺带告诉家里人**（用户 2026-10-16：「菜谱之类的」也要通知）：
 * 自建菜谱是**一家人共用的**（`familyId` 那一列，与冰箱同一层可见性），
 * 谁上传/改动/删掉都该让家人知道。AI 走的是同一套方法，所以 AI 干的那些也会通知——
 * 这是对的：家里人看到的仍然是"菜谱变了"，而且AI 的动作本来就该留痕（见 `AiAction`）。
 */
@Injectable()
export class RecipeWriteService {
  constructor(
    private readonly prisma: PrismaService,
    /** 「菜谱…有变化」要告诉家里人（用户 2026-10-16） */
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 取当前用户的家庭归属。**没有家庭也能建菜谱**——一家之主还没建家庭时
   * 想先记下自家菜谱是正常需求，所以 familyId 允许为空，那时菜谱只归他自己
   * （`createdById` 兜底），建了家庭之后再迁过来不是本刀的事。
   */
  private async actor(userId: string): Promise<{ userId: string; familyId: string | null }> {
    const membership = await this.prisma.familyMember.findUnique({ where: { userId } })
    return { userId, familyId: membership?.familyId ?? null }
  }

  /** 新建一道自建菜谱。返回建好的那道（形状与详情接口一致，前端可直接用） */
  async create(userId: string, raw: unknown) {
    const draft = parseRecipeCreate(raw)
    const who = await this.actor(userId)
    /*
     * 同名检查**只在本家范围内**做：全局库里已经有一道"番茄炒蛋"不妨碍你写自己的做法
     * （你的可能不放糖），那正是"自建"的意义。但同一家里出现两道同名会让人分不清，
     * 所以自家范围内要拦——这是与冰箱"同名同区只留一条"同一个考虑。
     */
    const clash = await this.prisma.recipe.findFirst({
      where: { familyId: who.familyId, name: draft.name },
      select: { id: true },
    })
    if (clash) throw new ConflictException(`你们家已经有一道「${draft.name}」了，直接改那一道就行`)

    const id = `own-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    // 配图是可选的：没传就一个字都不写（`imageKey` 留空 = 页面显示占位插画）
    const image = await this.storeImage(raw)
    const row = await this.prisma.recipe.create({
      data: {
        id,
        ...this.columns(draft),
        ...(image ?? {}),
        origin: RECIPE_ORIGIN_USER,
        // sourceKey 必须唯一（列上有唯一约束）：自建的用 id 派生一个，重新导入也不会撞
        sourceKey: `user:${id}`,
        familyId: who.familyId,
        createdById: who.userId,
        // 自建菜谱没有第三方出处，但许可证字段是接口契约的一部分，写清"这是用户自己的"
        source: {
          name: '自己上传',
          url: '',
          license: '用户原创',
          commit: '',
        } as unknown as Prisma.InputJsonValue,
      },
    })

    /*
     * 「菜谱…有变化」：谁上传了一道（用户 2026-10-16）。
     * 没加入家庭时 `who.familyId` 是 null——那时没有"家里人"可通知，直接不发
     * （`recordChange` 的收件人是按家庭算的，没有家庭就是空集）。
     */
    if (who.familyId) {
      await this.notifications.recordChange(who.familyId, {
        kind: 'recipe',
        action: `上传了新菜谱「${row.name}」`,
        body: [row.category, row.cuisine].filter(Boolean).join(' · ') || null,
        to: `/recipes/${row.id}`,
        mealKey: null,
        tag: '新菜谱',
        scope: `new:${row.id}`,
      }, userId)
    }

    return this.view(row)
  }

  /** 改一道自建菜谱（只改请求里出现的字段） */
  async update(userId: string, id: string, raw: unknown) {
    const row = await this.prisma.recipe.findUnique({ where: { id } })
    if (!row) throw new NotFoundException('没有这道菜谱')
    const who = await this.actor(userId)
    if (!canWriteRecipe(row, who)) throw new ForbiddenException(writeRefusal(row))

    /*
     * 配图也要在"有东西要改"的判断里算一份：只换一张图、别的字段一个字都没动，
     * 那也是有效的改动（不给它算，用户点「存好」会收到 400「没有要改的内容」）。
     */
    const patch = parseRecipePatch(raw, { allowEmpty: imageProvided(raw) })
    // 改名同样要查自家重名（改成一个已经存在的名字，还是分不清哪道是哪道）
    if (patch.name && patch.name !== row.name) {
      const clash = await this.prisma.recipe.findFirst({
        where: { familyId: row.familyId, name: patch.name, id: { not: id } },
        select: { id: true },
      })
      if (clash) throw new ConflictException(`你们家已经有一道「${patch.name}」了`)
    }

    /*
     * 改完之后 searchText 要重算——**用改后的完整值**（不是只把 patch 那部分拼进去）。
     * 用 `{...row, ...patch}` 是因为 patch 里的字段可能只给了一部分，
     * 剩下的必须沿用库里那份（漏掉的话，改一个数量就会把别的配料从搜索里抹掉）。
     */
    const merged: RecipeDraft = {
      name: patch.name ?? row.name,
      category: patch.category ?? row.category,
      cuisine: patch.cuisine ?? row.cuisine,
      tags: patch.tags ?? (row.tags as string[]),
      ingredients: patch.ingredients ?? (row.ingredients as unknown as Ingredient[]),
      steps: patch.steps ?? (row.steps as string[]),
      notes: patch.notes ?? (row.notes as string[]),
      calories: patch.calories !== undefined ? patch.calories : row.calories,
      aliases: patch.aliases ?? (row.aliases as string[]),
    }
    const updated = await this.prisma.recipe.update({
      where: { id },
      data: { ...this.columns(merged), ...(await this.storeImage(raw)) },
    })

    /*
     * 「菜谱…有变化」：谁改了哪一道（用户 2026-10-16）。
     * 改名了就把新旧名字都说出来（"改成了 X"），没改名就说"改了"——
     * 那句话对家里人是有用的：一道菜的做法变了，做过的人下次照着做就不一样了。
     *
     * 幂等键里带 **`updatedAt` 的时刻**（Prisma 在这次 update 里写下的那个值，
     * 一次修改一个时刻）：这一条与冰箱那条的取舍**故意不同**——冰箱改的是"它现在是 X"
     * （同一个值说一次就够），而这里是"**有人动了某道菜谱**"，那是动作，
     * 动十次就该看到十次。代价是"请求成功了但响应丢了、客户端重试"会多出一条
     * ——比"第二次改菜谱家里人完全不知道"轻得多。
     */
    if (row.familyId) {
      await this.notifications.recordChange(row.familyId, {
        kind: 'recipe',
        action: patch.name && patch.name !== row.name
          ? `把菜谱「${row.name}」改名成「${patch.name}」`
          : `改了菜谱「${row.name}」`,
        body: null,
        to: `/recipes/${id}`,
        mealKey: null,
        tag: '改了',
        scope: `edit:${id}:${updated.updatedAt.getTime()}`,
      }, userId)
    }

    return this.view(updated)
  }

  /** 删一道自建菜谱。**只删菜谱本身**：点单记录、收藏、组合里的引用按 schema 的 onDelete 走 */
  async remove(userId: string, id: string) {
    const row = await this.prisma.recipe.findUnique({ where: { id }, select: { id: true, name: true, familyId: true, createdById: true } })
    if (!row) throw new NotFoundException('没有这道菜谱')
    const who = await this.actor(userId)
    if (!canWriteRecipe(row, who)) throw new ForbiddenException(writeRefusal(row))
    await this.prisma.recipe.delete({ where: { id } })

    /*
     * 「菜谱…有变化」：谁删了哪一道（用户 2026-10-16）。
     *
     * 注意：**撤销 AI 删除（`restore`）不发提醒**——那条路是"把误删的还回来"，
     * 发一条"还回来了"家里人也没做什么新事；而真正重要的是"它曾经被删掉过"，
     * 那一条已经在删除时发出去了（历史不抹）。
     */
    if (row.familyId) {
      await this.notifications.recordChange(row.familyId, {
        kind: 'recipe',
        action: `删掉了菜谱「${row.name}」`,
        body: null,
        to: '/recipes',
        mealKey: null,
        tag: '删了',
        scope: `del:${id}`,
      }, userId)
    }

    return { id: row.id, name: row.name }
  }

  /**
   * 照原样重建一条被删掉的自建菜谱（撤「AI 删了菜谱」那笔）。
   *
   * **直接走 prisma.create 而不是 `create()`**：撤销要还原的是**当时那一行**
   * （包括它的 id、原属家庭、原上传人）。走 `create()` 会重新生成 id、并把它挂到
   * "现在这个用户当前的家庭"上——用户换了家庭之后撤销，那条就会跑到新的家里去。
   * 校验也不必再过一遍：这一行本来就是从这个库里删出去的，它的形状库是认的。
   */
  async restore(recipe: {
    id: string; name: string; category: string; cuisine: string; tags: string[]; aliases: string[]
    ingredients: { name: string; amount: string }[]; steps: string[]; notes: string[]
    calories: number | null; familyId: string | null; createdById: string | null; searchText: string
    image?: string | null; imageKey?: string | null; imageHash?: string | null; imageStoredAt?: string | null
  }) {
    const row = await this.prisma.recipe.create({
      data: {
        id: recipe.id,
        name: recipe.name,
        category: recipe.category,
        cuisine: recipe.cuisine,
        tags: recipe.tags as unknown as Prisma.InputJsonValue,
        aliases: recipe.aliases as unknown as Prisma.InputJsonValue,
        ingredients: recipe.ingredients as unknown as Prisma.InputJsonValue,
        steps: recipe.steps as unknown as Prisma.InputJsonValue,
        notes: recipe.notes as unknown as Prisma.InputJsonValue,
        tools: [] as unknown as Prisma.InputJsonValue,
        calories: recipe.calories,
        caloriesEstimated: false,
        searchText: recipe.searchText,
        // 配图原样还回来（对象按内容哈希命名，删菜谱从来不动存储里的字节，
        // 所以这里只需把 key 与 hash 写回列上，图立刻就在）
        image: recipe.image ?? null,
        imageKey: recipe.imageKey ?? null,
        imageHash: recipe.imageHash ?? null,
        imageStoredAt: recipe.imageStoredAt ? new Date(recipe.imageStoredAt) : null,
        origin: RECIPE_ORIGIN_USER,
        sourceKey: `user:${recipe.id}`,
        familyId: recipe.familyId,
        createdById: recipe.createdById,
        source: {
          name: '自己上传',
          url: '',
          license: '用户原创',
          commit: '',
        } as unknown as Prisma.InputJsonValue,
      },
    })
    return this.view(row)
  }

  /** 列表/详情要用的"能不能改"——前端据此决定画不画编辑按钮，AI 也用它回话 */
  async writable(userId: string, id: string): Promise<boolean> {
    const row = await this.prisma.recipe.findUnique({ where: { id }, select: { familyId: true, createdById: true } })
    if (!row) return false
    return canWriteRecipe(row, await this.actor(userId))
  }

  /**
   * 把请求里的配图存进对象存储，返回要写进库的那几列；没传图就返回 null。
   *
   * 与菜谱图床同一套口径（`media/media.storage`）：**内容哈希当文件名**——
   * 同一张图重复上传只占一份空间，写入天然幂等，也能长期强缓存。
   *
   * `image` 那一列**同时写一份公开地址**：`publicImageUrl` 优先用 `imageKey`，
   * 但也有人（脚本、往后的导出）只看 `image`。两列指向同一个对象，不会分叉。
   */
  private async storeImage(raw: unknown): Promise<{ image: string; imageKey: string; imageHash: string; imageStoredAt: Date } | null> {
    const body = (raw ?? {}) as { image?: unknown }
    if (body.image === undefined || body.image === null || body.image === '') return null

    const { bytes, contentType } = decodeImage(body.image)
    const hash = createHash('sha256').update(bytes).digest('hex')
    const key = mediaKey(hash, extensionForContentType(contentType) ?? 'jpg')

    const config = mediaS3Config()
    const client = s3Client(config)
    // 请求路自己把桶建出来：不能假设"导入脚本先跑过一次"（新环境里用户可能先传图）
    await ensureBucket(client, config)
    await putImage(client, config, key, bytes)

    const url = publicImageUrl(key, null)
    return {
      image: url ?? key,
      imageKey: key,
      imageHash: hash,
      imageStoredAt: new Date(),
    }
  }

  /**
   * 一份菜谱写进库的那几列。抽出来是因为 create 与 update 必须**逐字一致**——
   * 少写一列（比如忘带 searchText）在 create 上会立刻报错，在 update 上却是静默的：
   * 那条菜谱从此搜不到（"我明明改过它"）。
   */
  private columns(draft: RecipeDraft) {
    return {
      name: draft.name,
      category: draft.category,
      cuisine: draft.cuisine,
      tags: draft.tags as unknown as Prisma.InputJsonValue,
      aliases: draft.aliases as unknown as Prisma.InputJsonValue,
      ingredients: draft.ingredients as unknown as Prisma.InputJsonValue,
      steps: draft.steps as unknown as Prisma.InputJsonValue,
      notes: draft.notes as unknown as Prisma.InputJsonValue,
      // 自建的菜谱没有工具/视频这两项，给空数组而不是 null：接口契约里它们是列表
      tools: [] as unknown as Prisma.InputJsonValue,
      calories: draft.calories,
      // 用户自己填的热量就是"他知道的数"，不是估算——与导入器那套估算标记区分开
      caloriesEstimated: false,
      searchText: buildSearchText(draft),
    }
  }

  /** 与读接口同一形状（前端拿到就能当详情用，不必再取一次） */
  private view(row: {
    id: string; name: string; image: string | null; imageKey: string | null; category: string; cuisine: string
    tags: Prisma.JsonValue; aliases: Prisma.JsonValue; calories: number | null; caloriesEstimated: boolean
    spiciness: number; ingredients: Prisma.JsonValue; steps: Prisma.JsonValue; notes: Prisma.JsonValue
    videoUrl: string | null; source: Prisma.JsonValue; origin: string
    familyId: string | null; createdById: string | null
  }, viewer?: { userId: string; familyId: string | null } | null) {
    return {
      id: row.id,
      name: row.name,
      image: publicImageUrl(row.imageKey, row.image),
      category: row.category,
      cuisine: row.cuisine,
      tags: row.tags as string[],
      calories: row.calories,
      caloriesEstimated: row.caloriesEstimated,
      spiciness: row.spiciness,
      aliases: row.aliases as string[],
      ingredients: row.ingredients as unknown as Ingredient[],
      steps: row.steps as string[],
      notes: row.notes as string[],
      videoUrl: row.videoUrl,
      source: row.source as unknown as RecipeSource,
      origin: row.origin,
      sourceLabel: sourceLabel(row.origin),
      createdBy: null as string | null,
      /*
       * 写操作回来的那份也要带 `mine`：不给的话，前端刚建完这道菜时手里那个对象
       * 是 `mine: undefined`（实测撞到过）——"刚建的菜自己能不能改"这件事在返回值里
       * 就成了一个说不清的状态，而它明明恒为 true（自己刚建的）。
       */
      mine: viewer === undefined ? true : Boolean(viewer) && canWriteRecipe(row, viewer as { userId: string; familyId: string | null }),
    }
  }
}
