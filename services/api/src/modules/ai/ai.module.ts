import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { CombosModule } from '../combos/combos.module'
import { FavoritesModule } from '../favorites/favorites.module'
import { FridgeModule } from '../fridge/fridge.module'
import { OrdersModule } from '../orders/orders.module'
import { RecipesModule } from '../recipes/recipes.module'
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
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
    FridgeModule,
    // 自建菜谱的写走 RecipesModule 导出的 RecipeWriteService（F1-12）；
    // 收藏走用户自己的 FavoritesService（F1-09）——与冰箱同一条规矩：AI 不另写一套写入逻辑
    RecipesModule,
    FavoritesModule,
    // 菜单与组合：AI 全应用 CRUD 的落点（点菜/撤菜/人数/状态/再点一次/组合四件）
    OrdersModule,
    CombosModule,
  ],
  controllers: [AiController],
  providers: [PrismaService, AiService, AiActionService, AiAttachmentService, JwtAuthGuard],
})
export class AiModule {}
