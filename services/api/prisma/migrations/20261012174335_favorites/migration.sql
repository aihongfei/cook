/*
 * 这行是 Prisma 的**伪漂移**，不是真改动：MySQL 8 在 INFORMATION_SCHEMA 里把 4 字节 emoji
 * 显示成 `?`，于是每次 migrate 都会把 User.avatar 再"改"一次。
 * 库里本来就是 `VARCHAR(16) NOT NULL DEFAULT '🐰'`，所以这里删掉、不重复执行（口径见 RUNBOOK R-007）。
 */
SET NAMES utf8mb4;

-- CreateTable
CREATE TABLE `Favorite` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `recipeId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `Favorite_userId_createdAt_idx`(`userId`, `createdAt`),
    UNIQUE INDEX `Favorite_userId_recipeId_key`(`userId`, `recipeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Favorite` ADD CONSTRAINT `Favorite_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Favorite` ADD CONSTRAINT `Favorite_recipeId_fkey` FOREIGN KEY (`recipeId`) REFERENCES `Recipe`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
