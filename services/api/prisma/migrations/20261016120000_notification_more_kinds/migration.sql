-- 消息提醒扩容（用户 2026-10-16：「订单有变化、打卡墙有上传/评论、家庭有变化、冰箱有变化，
-- 就是家庭相关修改的都需要通知」）：开关从 4 个扩到 9 个，事件日志补 `mealKey`/`tag` 两列。
--
-- 为什么需要 `mealKey`/`tag`：这一版起有两类提醒（见 schema.prisma 的 NotificationEvent）。
-- **状态型**那四类（菜单/做好了/快过期/该备菜）仍然现算，它们的 `mealKey`/`tag` 由现算那边给出；
-- **事件型**那六类（点菜/冰箱/打卡/评论/家庭/菜谱）说的是一件**发生过就不在库里了**的事
-- （撤了一道菜、从冰箱拿走一盒奶、谁改了家庭名），没有"事实"可反推，所以当场写下来——
-- 于是这两列也得存下来，否则点单列表没法把"这张卡有事没看过"标出来。
--
-- 加列都带 DEFAULT true / NULL，老行不需要回填：9 个开关默认全是"开"，
-- 与 `NotificationPref` 表既有口径一致（没改过开关的人本来就该收到全部提醒）。
--
-- 关于下面那句 `MODIFY avatar`：与 meal_orders、meal_confirm、check_ins 几次迁移里是同一件事——
-- Prisma 的**假漂移**，不是坏数据。MySQL 8 的数据字典用 utf8mb3 存默认值的显示文本，
-- 4 字节 emoji 在 INFORMATION_SCHEMA 里一律显示成 '?'，于是 `migrate diff` 每次都觉得
-- schema 的 '🐰' 与库里不一致。保留它只是把这段噪音落在这一份里（删掉只是推迟到下次）。
SET NAMES utf8mb4;

-- AlterTable
ALTER TABLE `User` MODIFY `avatar` VARCHAR(16) NOT NULL DEFAULT '🐰';

-- AlterTable
ALTER TABLE `NotificationEvent` ADD COLUMN `mealKey` VARCHAR(32) NULL,
    ADD COLUMN `tag` VARCHAR(16) NULL;

-- AlterTable
ALTER TABLE `NotificationPref` ADD COLUMN `checkin` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `family` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `fridgeChange` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `orderChange` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `recipe` BOOLEAN NOT NULL DEFAULT true;
