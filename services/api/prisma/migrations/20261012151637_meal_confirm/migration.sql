-- M4 / F4-05：确认菜单的留痕——谁把这一版菜单定下来的、什么时候。
-- 关于这里那句 MODIFY avatar：与 meal_orders、check_ins、meal_diner_count、combos 几次迁移里是同一件事——
-- MySQL 8 数据字典用 utf8mb3 存默认值的显示文本，4 字节 emoji 在 INFORMATION_SCHEMA 里显示成 '?'（0x3F），
-- 于是 `migrate diff` 认为库里与 schema 不一致，每次都多出这句。**默认值实际是对的**
-- （插一行不带 avatar 的记录读回来是 F09F90B0＝🐰，已实测）。这句保留在迁移里（删掉只是把噪音推迟），
-- 不追这个幽灵。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `MealOrder` ADD COLUMN `confirmedAt` DATETIME(3) NULL,
    ADD COLUMN `confirmedById` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- AddForeignKey
ALTER TABLE `MealOrder` ADD CONSTRAINT `MealOrder_confirmedById_fkey` FOREIGN KEY (`confirmedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
