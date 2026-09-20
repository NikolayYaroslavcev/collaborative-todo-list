-- CreateTable
CREATE TABLE "ReorderIdempotencyRecord" (
    "userId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReorderIdempotencyRecord_pkey" PRIMARY KEY ("userId","operationId")
);
