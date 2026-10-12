-- M4 / F4-05：就餐人数（含没点菜只吃饭的家人），由掌勺人/帮厨设定。
-- 关于第一句 MODIFY avatar：与 meal_orders、check_ins 两次迁移里是同一件事——MySQL 8 数据字典用 utf8mb3
-- 存默认值的显示文本，4 字节 emoji 在 INFORMATION_SCHEMA 里显示成 '?'（0x3F），于是 `migrate diff`
-- 认为库里与 schema 不一致，每次都多出这句。**默认值实际是对的**（插一行不带 avatar 的记录读回来是
-- F09F90B0＝🐰，已实测）。这句保留在迁移里（删掉只是把噪音推迟），不追这个幽灵。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- AlterTable
ALTER TABLE `MealOrder` ADD COLUMN `dinerCount` INTEGER NULL;
