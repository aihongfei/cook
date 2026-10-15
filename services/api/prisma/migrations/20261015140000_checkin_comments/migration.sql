-- 打卡底下的评论（用户 2026-10-15：「我的打卡墙要添加评论功能，还要添加打开编辑和删除功能，评论也要」）。
--
-- ⚠️ 为什么是手写的：`prisma migrate dev` 在这个库上会要求 **重置整个开发库**（drop 掉所有数据）。
-- 原因是 10-14 那批迁移在 _prisma_migrations 里留了**两条失败记录**
-- （`20261014130000_notification_events` 与 `20261014131500_patrol_token_per_device`，
-- 都是 applied_steps_count=0、已标 rolled_back 的空记录：当时非交互环境下第一条语句没跑成，
-- 重跑成功之后旧的那条留在表里）。`migrate status` 说 "Database schema is up to date!"，
-- 各迁移文件的校验和与库里成功那行**逐条比对也全部一致**——只有那两条历史噪声让 dev 命令要重置。
-- 为了加一张表而清空开发库（里面有真实点单/打卡/菜谱数据）不划算，所以：
-- ① 用 `prisma migrate diff --from-schema-datasource --to-schema-datamodel` 生成**真实差异**
--    （不是手写猜的 SQL，见上面那条命令），② 存成这个迁移，③ 由 Prisma 自己记账应用。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- CreateTable
CREATE TABLE `CheckInComment` (
    `id` VARCHAR(191) NOT NULL,
    `checkInId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `body` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `CheckInComment_checkInId_createdAt_idx`(`checkInId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CheckInComment` ADD CONSTRAINT `CheckInComment_checkInId_fkey` FOREIGN KEY (`checkInId`) REFERENCES `CheckIn`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `CheckInComment` ADD CONSTRAINT `CheckInComment_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
