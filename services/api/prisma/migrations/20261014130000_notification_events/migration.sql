-- AlterTable
ALTER TABLE `NotificationPref` DROP COLUMN `seenAt`;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `NotificationEvent` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(12) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `body` VARCHAR(200) NULL,
    `toPath` VARCHAR(64) NOT NULL,
    `at` DATETIME(3) NOT NULL,
    `readAt` DATETIME(3) NULL,
    `dedupeKey` VARCHAR(160) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `NotificationEvent_userId_at_idx`(`userId`, `at`),
    UNIQUE INDEX `NotificationEvent_dedupeKey_key`(`dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NotificationEvent` ADD CONSTRAINT `NotificationEvent_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
