-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "category" TEXT NOT NULL,
    "cuisine" TEXT NOT NULL,
    "aliases" JSONB NOT NULL,
    "tags" JSONB NOT NULL,
    "calories" REAL,
    "caloriesEstimated" BOOLEAN NOT NULL DEFAULT false,
    "spiciness" INTEGER NOT NULL DEFAULT 0,
    "ingredients" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "notes" JSONB NOT NULL,
    "tools" JSONB NOT NULL,
    "videoUrl" TEXT,
    "source" JSONB NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'user',
    "sourceKey" TEXT,
    "sourcePath" TEXT,
    "rawMarkdown" TEXT,
    "searchText" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Recipe_sourceKey_key" ON "Recipe"("sourceKey");

-- CreateIndex
CREATE INDEX "Recipe_category_cuisine_idx" ON "Recipe"("category", "cuisine");

-- CreateIndex
CREATE INDEX "Recipe_origin_idx" ON "Recipe"("origin");
