/*
  Warnings:

  - You are about to drop the column `categories` on the `AgentProfile` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AgentProfile" DROP COLUMN "categories";

-- CreateTable
CREATE TABLE "Category" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "mainPic" TEXT,
    "coverPic" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_AgentProfileToCategory" (
    "A" UUID NOT NULL,
    "B" UUID NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "_AgentProfileToCategory_AB_unique" ON "_AgentProfileToCategory"("A", "B");

-- CreateIndex
CREATE INDEX "_AgentProfileToCategory_B_index" ON "_AgentProfileToCategory"("B");

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AgentProfileToCategory" ADD CONSTRAINT "_AgentProfileToCategory_A_fkey" FOREIGN KEY ("A") REFERENCES "AgentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_AgentProfileToCategory" ADD CONSTRAINT "_AgentProfileToCategory_B_fkey" FOREIGN KEY ("B") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;
