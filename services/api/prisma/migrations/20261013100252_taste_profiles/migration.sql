-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `TasteProfile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `spicyLevel` INTEGER NULL,
    `flavors` JSON NOT NULL,
    `diet` VARCHAR(12) NULL,
    `allergies` JSON NOT NULL,
    `dislikes` JSON NOT NULL,
    `note` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TasteProfile_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TasteProfile` ADD CONSTRAINT `TasteProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
