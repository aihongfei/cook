-- AlterTable
ALTER TABLE `Recipe` ADD COLUMN `imageHash` VARCHAR(64) NULL,
    ADD COLUMN `imageKey` VARCHAR(512) NULL,
    ADD COLUMN `imageStoredAt` DATETIME(3) NULL;
