-- 点单（M3 / F3-01~F3-05，D-022）：按「家庭 + 日期 + 餐次」聚合的 MealOrder + 逐菜 OrderItem。
--
-- 关于下面第一句 `MODIFY avatar`：它是 **Prisma 的假漂移**，不是坏数据。
-- MySQL 8 的数据字典用 utf8mb3 存默认值的显示文本，4 字节 emoji 在
-- INFORMATION_SCHEMA.COLUMNS 里一律显示成 '?'（0x3F），于是 prisma migrate diff 每次都认为
-- schema 的 '🐰' 与库里不一致，反复生成这句。（实测确认过功能没问题：
-- 插一行不带 avatar 的记录，读回来是 F09F90B0，即 🐰。）
--
-- 保留它的原因：① 删掉只是把这段噪音推迟到下次生成迁移；② 万一某个环境的迁移连接不是
-- utf8mb4，这句会真正把默认值修正过来。SET NAMES 保证 4 字节字面量按 utf8mb4 解释。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `MealOrder` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `mealDate` DATE NOT NULL,
    `meal` ENUM('LUNCH', 'DINNER') NOT NULL,
    `status` ENUM('PENDING', 'PLANNED', 'COOKING', 'DONE', 'CANCELED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MealOrder_familyId_mealDate_idx`(`familyId`, `mealDate`),
    UNIQUE INDEX `MealOrder_familyId_mealDate_meal_key`(`familyId`, `mealDate`, `meal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderItem` (
    `id` VARCHAR(191) NOT NULL,
    `mealOrderId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `recipeId` VARCHAR(191) NULL,
    `recipeName` VARCHAR(120) NOT NULL,
    `recipeImage` VARCHAR(512) NULL,
    `note` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderItem_mealOrderId_idx`(`mealOrderId`),
    INDEX `OrderItem_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MealOrder` ADD CONSTRAINT `MealOrder_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_mealOrderId_fkey` FOREIGN KEY (`mealOrderId`) REFERENCES `MealOrder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderItem` ADD CONSTRAINT `OrderItem_recipeId_fkey` FOREIGN KEY (`recipeId`) REFERENCES `Recipe`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

