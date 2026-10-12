-- 打卡照片（M9 / F9-03、F9-07、F9-08；口径见 D-023）。
-- 照片本体存私有桶（cook-checkins，不设公开读策略），表里只存对象 key 与内容哈希。
--
-- 关于第一句 MODIFY avatar：与 meal_orders 迁移里同一件事——MySQL 8 数据字典用 utf8mb3
-- 存默认值的显示文本，4 字节 emoji 在 INFORMATION_SCHEMA 里一律显示成 '?'（0x3F），
-- 所以 prisma migrate diff 每次都认为不一致而重复生成这句。保留（删掉只是把噪音推迟到下次）。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `CheckIn` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `mealOrderId` VARCHAR(191) NULL,
    `imageKey` VARCHAR(512) NOT NULL,
    `imageHash` VARCHAR(64) NOT NULL,
    `checkDate` DATE NOT NULL,
    `note` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `CheckIn_familyId_createdAt_idx`(`familyId`, `createdAt`),
    INDEX `CheckIn_familyId_checkDate_idx`(`familyId`, `checkDate`),
    INDEX `CheckIn_userId_checkDate_idx`(`userId`, `checkDate`),
    INDEX `CheckIn_mealOrderId_idx`(`mealOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckIn` ADD CONSTRAINT `CheckIn_mealOrderId_fkey` FOREIGN KEY (`mealOrderId`) REFERENCES `MealOrder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

