import { Module } from '@nestjs/common'
import { BuiltinRecipeProvider } from './builtin-recipe.provider'
import { PrismaService } from './prisma.service'
import { RECIPE_PROVIDER } from './recipe.types'
import { RecipesController } from './recipes.controller'

@Module({
  controllers: [RecipesController],
  providers: [PrismaService, BuiltinRecipeProvider, { provide: RECIPE_PROVIDER, useExisting: BuiltinRecipeProvider }],
  exports: [RECIPE_PROVIDER],
})
export class RecipesModule {}
