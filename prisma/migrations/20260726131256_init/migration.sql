-- CreateEnum
CREATE TYPE "School" AS ENUM ('IWATAKI', 'AMINO');

-- CreateEnum
CREATE TYPE "CourseFormat" AS ENUM ('TSUGAKU', 'GASSHUKU');

-- CreateEnum
CREATE TYPE "Transmission" AS ENUM ('AT', 'MT');

-- CreateEnum
CREATE TYPE "CourseCategory" AS ENUM ('LICENSE', 'DRONE', 'KENKI', 'ADDITIONAL');

-- CreateEnum
CREATE TYPE "LicenseType" AS ENUM ('ORDINARY', 'SEMI_MEDIUM', 'MEDIUM', 'LARGE', 'ORDINARY_2ND', 'LARGE_2ND', 'TOWING', 'LARGE_SPECIAL', 'MOTORCYCLE');

-- CreateEnum
CREATE TYPE "NewsCategory" AS ENUM ('IWATAKI', 'AMINO', 'DRONE', 'KENKI', 'COMMON');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "FaqCategory" AS ENUM ('SCHOOL', 'COURSE', 'PAYMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ApplicationType" AS ENUM ('APPLICATION', 'INQUIRY');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "PhotoSide" AS ENUM ('FRONT', 'BACK');

-- CreateEnum
CREATE TYPE "ChatSourceType" AS ENUM ('COURSE', 'ACCESS');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('ADMIN');

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "category" "CourseCategory" NOT NULL,
    "licenseType" "LicenseType",
    "licenseTypeLabel" TEXT,
    "transmission" "Transmission",
    "programLabel" TEXT,
    "format" "CourseFormat",
    "minDays" INTEGER NOT NULL,
    "priceFrom" INTEGER NOT NULL,
    "schools" "School"[],
    "subsidyTags" TEXT[],
    "description" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "News" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "NewsCategory" NOT NULL,
    "status" "PublishStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "News_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faq" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "category" "FaqCategory" NOT NULL,
    "keywords" TEXT[],
    "published" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "type" "ApplicationType" NOT NULL,
    "plans" TEXT[],
    "courseId" TEXT,
    "courseNameSnapshot" TEXT,
    "priceFromSnapshot" INTEGER,
    "school" "School",
    "format" "CourseFormat",
    "name" TEXT NOT NULL,
    "nameKana" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3) NOT NULL,
    "gender" TEXT,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "postalCode" TEXT,
    "address" TEXT,
    "buildingName" TEXT,
    "licenseRevoked" BOOLEAN,
    "licenseRevokedNote" TEXT,
    "currentLicenses" TEXT[],
    "preferredStartMonth" TEXT,
    "preferredTimeSlot" TEXT,
    "paymentMethod" TEXT,
    "firstTime" BOOLEAN,
    "referralSources" TEXT[],
    "message" TEXT,
    "privacyConsent" BOOLEAN NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LicensePhoto" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "side" "PhotoSide" NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LicensePhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "maxSize" INTEGER NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplementalChatRule" (
    "id" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "patterns" TEXT[],
    "reply" TEXT NOT NULL,
    "sourceType" "ChatSourceType" NOT NULL,
    "sourceRefId" TEXT,
    "linkUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupplementalChatRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Course_category_published_sortOrder_idx" ON "Course"("category", "published", "sortOrder");

-- CreateIndex
CREATE INDEX "Course_published_format_idx" ON "Course"("published", "format");

-- CreateIndex
CREATE INDEX "News_status_publishedAt_idx" ON "News"("status", "publishedAt");

-- CreateIndex
CREATE INDEX "News_category_status_publishedAt_idx" ON "News"("category", "status", "publishedAt");

-- CreateIndex
CREATE INDEX "Faq_published_category_sortOrder_idx" ON "Faq"("published", "category", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Application_receiptNumber_key" ON "Application"("receiptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Application_idempotencyKey_key" ON "Application"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Application_type_status_createdAt_idx" ON "Application"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "LicensePhoto_applicationId_idx" ON "LicensePhoto"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "UploadToken_token_key" ON "UploadToken"("token");

-- CreateIndex
CREATE INDEX "UploadToken_expiresAt_idx" ON "UploadToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LicensePhoto" ADD CONSTRAINT "LicensePhoto_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
