-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `AiAction` (
    `id` VARCHAR(191) NOT NULL,
    `familyId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `summary` VARCHAR(120) NOT NULL,
    `undoData` JSON NOT NULL,
    `undoneAt` DATETIME(3) NULL,
    `targetId` VARCHAR(40) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `AiAction_familyId_createdAt_idx`(`familyId`, `createdAt`),
    INDEX `AiAction_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AiAction` ADD CONSTRAINT `AiAction_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AiAction` ADD CONSTRAINT `AiAction_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
