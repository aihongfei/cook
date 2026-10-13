import { Module } from '@nestjs/common'
import { JwtModule } from '@nestjs/jwt'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { OptionalAuthGuard } from '../auth/optional-auth.guard'
import { jwtSecret } from '../auth/jwt.config'
import { BuiltinRecipeProvider } from './builtin-recipe.provider'
import { PrismaService } from './prisma.service'
import { RECIPE_PROVIDER } from './recipe.types'
import { RecipeWriteService } from './recipe-write.service'
import { RecipesController } from './recipes.controller'

/**
 * 菜谱读写（M1 / F1-12）。
 *
 * 引 JwtModule 是为了那个**可选鉴权**守卫：列表要"匿名看全局库、登录后带上自家的"，
 * 所以得能自己验令牌（JwtModule 的作用域按模块隔离，与其他模块同一做法）。
 *
 * `RecipeWriteService` 也导出：AI 的菜谱工具要用它，**不允许 AI 另写一份写入逻辑**
 * （与冰箱那条同一个规矩，见 D-052）。
 */
@Module({
  imports: [
    JwtModule.register({
      secret: jwtSecret(),
      signOptions: { expiresIn: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 7200) },
    }),
  ],
  controllers: [RecipesController],
  providers: [
    PrismaService,
    BuiltinRecipeProvider,
    { provide: RECIPE_PROVIDER, useExisting: BuiltinRecipeProvider },
    RecipeWriteService,
    JwtAuthGuard,
    OptionalAuthGuard,
  ],
  exports: [RECIPE_PROVIDER, RecipeWriteService],
})
export class RecipesModule {}
