-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `ShoppingCheck` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `checkedById` VARCHAR(191) NOT NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShoppingCheck_familyId_checkedAt_idx`(`familyId`, `checkedAt`),
    UNIQUE INDEX `ShoppingCheck_familyId_name_key`(`familyId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShoppingExtra` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(40) NOT NULL,
    `amount` VARCHAR(24) NULL,
    `addedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ShoppingExtra_familyId_createdAt_idx`(`familyId`, `createdAt`),
    UNIQUE INDEX `ShoppingExtra_familyId_name_key`(`familyId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ShoppingCheck` ADD CONSTRAINT `ShoppingCheck_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShoppingCheck` ADD CONSTRAINT `ShoppingCheck_checkedById_fkey` FOREIGN KEY (`checkedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShoppingExtra` ADD CONSTRAINT `ShoppingExtra_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ShoppingExtra` ADD CONSTRAINT `ShoppingExtra_addedById_fkey` FOREIGN KEY (`addedById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
