-- M6 / F6-01：冰箱食材（家庭共用的"家里确实有什么"）。形态见 D-049。
-- 第一句 MODIFY avatar 与 meal_orders / check_ins / combos 三次迁移里是同一件事：
-- MySQL 8 数据字典用 utf8mb3 显示默认值，4 字节 emoji 在 INFORMATION_SCHEMA 里显示成 '?'（0x3F），
-- 于是 migrate diff 每次都认为不一致、多出这一句。默认值实际是对的（已实测，见 combos 迁移的说明）。
-- 不追这个幽灵。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `FridgeItem` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `addedById` VARCHAR(191) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `amount` VARCHAR(24) NULL,
    `zone` VARCHAR(12) NOT NULL DEFAULT '冷藏',
    `expiresOn` DATE NULL,
    `note` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FridgeItem_familyId_zone_idx`(`familyId`, `zone`),
    INDEX `FridgeItem_familyId_expiresOn_idx`(`familyId`, `expiresOn`),
    UNIQUE INDEX `FridgeItem_familyId_zone_name_key`(`familyId`, `zone`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `FridgeItem` ADD CONSTRAINT `FridgeItem_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `FridgeItem` ADD CONSTRAINT `FridgeItem_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
