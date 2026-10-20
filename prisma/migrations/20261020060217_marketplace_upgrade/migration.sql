-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('NEW', 'READ', 'ARCHIVED');

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "description" TEXT,
ADD COLUMN     "imageUrl" TEXT;

-- AlterTable
ALTER TABLE "Lot" ADD COLUMN     "currentPriceCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "location" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "specs" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "contactName" TEXT,
ADD COLUMN     "location" TEXT,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "comment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotView" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotView_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactMessage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsletterSubscriber" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsletterSubscriber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Review_sellerId_createdAt_idx" ON "Review"("sellerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Review_lotId_authorId_key" ON "Review"("lotId", "authorId");

-- CreateIndex
CREATE INDEX "LotView_lotId_createdAt_idx" ON "LotView"("lotId", "createdAt");

-- CreateIndex
CREATE INDEX "LotView_createdAt_idx" ON "LotView"("createdAt");

-- CreateIndex
CREATE INDEX "ContactMessage_status_createdAt_idx" ON "ContactMessage"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NewsletterSubscriber_email_key" ON "NewsletterSubscriber"("email");

-- CreateIndex
CREATE INDEX "Lot_status_currentPriceCents_idx" ON "Lot"("status", "currentPriceCents");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotView" ADD CONSTRAINT "LotView_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotView" ADD CONSTRAINT "LotView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ratings are 1 to 5 stars; the API validates this too.
ALTER TABLE "Review" ADD CONSTRAINT "Review_rating_range" CHECK ("rating" BETWEEN 1 AND 5);

-- "currentPriceCents" is what a buyer would pay now: the highest bid, or the
-- starting price before the first bid. A trigger keeps it in sync on every
-- insert and update, so the bidding, closing and rollover transactions (which
-- write currentHighestBidAmountCents) never have to remember it.
CREATE OR REPLACE FUNCTION lot_set_current_price() RETURNS trigger AS $$
BEGIN
  NEW."currentPriceCents" := COALESCE(NEW."currentHighestBidAmountCents", NEW."startingPriceCents");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lot_current_price
BEFORE INSERT OR UPDATE ON "Lot"
FOR EACH ROW EXECUTE FUNCTION lot_set_current_price();

-- Backfill existing lots (the trigger fills in the value).
UPDATE "Lot" SET "currentPriceCents" = COALESCE("currentHighestBidAmountCents", "startingPriceCents");
