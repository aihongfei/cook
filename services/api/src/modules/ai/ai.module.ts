import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { CheckInsModule } from '../checkins/checkins.module'
import { CombosModule } from '../combos/combos.module'
import { DiscoverModule } from '../discover/discover.module'
import { FavoritesModule } from '../favorites/favorites.module'
import { FridgeModule } from '../fridge/fridge.module'
import { OrdersModule } from '../orders/orders.module'
import { RecipesModule } from '../recipes/recipes.module'
import { ShoppingModule } from '../shopping/shopping.module'
import { TasteModule } from '../taste/taste.module'
import { PrismaService } from '../recipes/prisma.service'
import { AiActionService } from './ai-action.service'
import { AiAttachmentService } from './ai-attachment.service'
import { AiController } from './ai.controller'
import { AiService } from './ai.service'

/**
 * AI 推荐与问答（M16 子集 / 用户 2026-10-12 的新需求，口径见 D-026）；
 * 全局助手与"对话里办事"见 D-052（F16-10）。
 * 与 OrdersModule 同理：JwtModule 的作用域按模块隔离，这里要自己 register 一次。
 *
 * 引 `FridgeModule` / `RecipesModule` / `FavoritesModule` / `OrdersModule` / `CombosModule`
 * 是为了让 AI 走**用户自己那套服务**写库（不另写一份）：这样"AI 记的/写的"与
 * "用户手记手写的"在数据、校验、权限上没有半点区别（D-052）。
 * 典型好处：菜谱那条"只能改自家上传的"边界只写在 `recipe.rules` 里，
 * 菜单那条"只有自己点的能撤、这一餐收不收新菜"只在 `orders` 里，AI 自动继承——
 * 不必在提示词里靠模型自觉。
 *
 * **`DiscoverModule` / `CheckInsModule` 属于同一理由的只读版**：AI 的"帮我决定"
 * 与发现页那个按钮调的是同一个方法（`decide`），"家人最爱"与那一页共用 `familyPicks`，
 * "打卡多少天"用的是热力图里那个 `streak`。AI 自己算一份数字出来必然与界面上对不上。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    FridgeModule,
    TasteModule,
    // 自建菜谱的写走 RecipesModule 导出的 RecipeWriteService（F1-12）；
    // 收藏走用户自己的 FavoritesService（F1-09）——与冰箱同一条规矩：AI 不另写一套写入逻辑
    RecipesModule,
    FavoritesModule,
    // 菜单与组合：AI 全应用 CRUD 的落点（点菜/撤菜/人数/状态/再点一次/组合四件）
    OrdersModule,
    CombosModule,
    // 采购清单（M7，用户 2026-10-14 要求接入）：清单是**算出来的**（按菜单配料 + 自加条目），
    // 所以只能走它自己的 `list`——AI 另算一份必然与界面上看到的那张对不上
    ShoppingModule,
    // 只读三件（帮我决定 / 家人最爱 / 打卡，用户 2026-10-14）
    DiscoverModule,
    CheckInsModule,
  ],
  controllers: [AiController],
  providers: [PrismaService, AiService, AiActionService, AiAttachmentService, JwtAuthGuard],
})
export class AiModule {}
