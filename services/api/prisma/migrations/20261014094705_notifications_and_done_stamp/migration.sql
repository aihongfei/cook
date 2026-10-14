-- AlterTable
ALTER TABLE `MealOrder` ADD COLUMN `doneAt` DATETIME(3) NULL,
    ADD COLUMN `doneById` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `NotificationPref` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `seenAt` DATETIME(3) NULL,
    `mealPlan` BOOLEAN NOT NULL DEFAULT true,
    `mealDone` BOOLEAN NOT NULL DEFAULT true,
    `expiry` BOOLEAN NOT NULL DEFAULT true,
    `prep` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NotificationPref_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `MealOrder` ADD CONSTRAINT `MealOrder_doneById_fkey` FOREIGN KEY (`doneById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotificationPref` ADD CONSTRAINT `NotificationPref_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
