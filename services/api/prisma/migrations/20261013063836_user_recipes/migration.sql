-- AlterTable
ALTER TABLE `Recipe` ADD COLUMN `createdById` VARCHAR(191) NULL,
    ADD COLUMN `familyId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateIndex
CREATE INDEX `Recipe_familyId_idx` ON `Recipe`(`familyId`);

-- AddForeignKey
ALTER TABLE `Recipe` ADD CONSTRAINT `Recipe_familyId_fkey` FOREIGN KEY (`familyId`) REFERENCES `Family`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Recipe` ADD CONSTRAINT `Recipe_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
