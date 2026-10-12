-- CreateTable
CREATE TABLE `AppMeta` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `value` VARCHAR(191) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `AppMeta_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Recipe` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `image` VARCHAR(512) NULL,
    `category` VARCHAR(191) NOT NULL,
    `cuisine` VARCHAR(191) NOT NULL,
    `aliases` JSON NOT NULL,
    `tags` JSON NOT NULL,
    `calories` DOUBLE NULL,
    `caloriesEstimated` BOOLEAN NOT NULL DEFAULT false,
    `spiciness` INTEGER NOT NULL DEFAULT 0,
    `ingredients` JSON NOT NULL,
    `steps` JSON NOT NULL,
    `notes` JSON NOT NULL,
    `tools` JSON NOT NULL,
    `videoUrl` VARCHAR(512) NULL,
    `source` JSON NOT NULL,
    `origin` VARCHAR(191) NOT NULL DEFAULT 'user',
    `sourceKey` VARCHAR(191) NULL,
    `sourcePath` VARCHAR(512) NULL,
    `rawMarkdown` TEXT NULL,
    `searchText` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Recipe_sourceKey_key`(`sourceKey`),
    INDEX `Recipe_category_cuisine_idx`(`category`, `cuisine`),
    INDEX `Recipe_origin_idx`(`origin`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
