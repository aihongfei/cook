-- 巡查令牌从"按账号一行"改成"按账号 + 设备一行"（见 schema 里那段说明）
--
-- 为什么是手写的：`prisma migrate dev` 在这个环境里是非交互的，没法回答
-- "要不要接受这个唯一约束变更"。而这条改动的意图很明确、且表是空的
-- （这一版还没发出去过任何一枚令牌），所以直接写清四步：
-- 补上设备列 → 换掉那个唯一索引（旧的先让给外键用，所以用两步换名字）→ 删旧。
--
-- ⚠️ 那个 `userId` 上的唯一索引同时被外键依赖：MySQL 不允许直接删掉它，
-- 所以顺序必须是"先建新的、再删旧的"，中间那一步新索引已经能顶上外键的需要。
ALTER TABLE `NotificationPatrolToken` ADD COLUMN `deviceId` VARCHAR(64) NOT NULL;

CREATE UNIQUE INDEX `NotificationPatrolToken_userId_deviceId_key` ON `NotificationPatrolToken`(`userId`, `deviceId`);

DROP INDEX `NotificationPatrolToken_userId_key` ON `NotificationPatrolToken`;
