-- M4 / F4-04：常用组合（家庭共用的一组菜）。ComboItem 指向菜谱，菜谱删除时级联清理。
-- 关于第一句 MODIFY avatar：与 meal_orders、check_ins、meal_diner_count 三次迁移里是同一件事——
-- MySQL 8 数据字典用 utf8mb3 存默认值的显示文本，4 字节 emoji 在 INFORMATION_SCHEMA 里显示成 '?'
-- （0x3F），于是 `migrate diff` 认为库里与 schema 不一致，每次都多出这句。**默认值实际是对的**
-- （插一行不带 avatar 的记录读回来是 F09F90B0＝🐰，已实测）。这句保留在迁移里（删掉只是把噪音推迟），
-- 不追这个幽灵。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `Combo` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `name` VARCHAR(24) NOT NULL,
    `note` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Combo_familyId_createdAt_idx`(`familyId`, `createdAt`),
    UNIQUE INDEX `Combo_familyId_name_key`(`familyId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ComboItem` (
    `id` VARCHAR(191) NOT NULL,
    `comboId` VARCHAR(191) NOT NULL,
    `recipeId` VARCHAR(191) NOT NULL,
    `position` INTEGER NOT NULL DEFAULT 0,

    INDEX `ComboItem_comboId_position_idx`(`comboId`, `position`),
    UNIQUE INDEX `ComboItem_comboId_recipeId_key`(`comboId`, `recipeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Combo` ADD CONSTRAINT `Combo_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Combo` ADD CONSTRAINT `Combo_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ComboItem` ADD CONSTRAINT `ComboItem_comboId_fkey` FOREIGN KEY (`comboId`) REFERENCES `Combo`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ComboItem` ADD CONSTRAINT `ComboItem_recipeId_fkey` FOREIGN KEY (`recipeId`) REFERENCES `Recipe`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
