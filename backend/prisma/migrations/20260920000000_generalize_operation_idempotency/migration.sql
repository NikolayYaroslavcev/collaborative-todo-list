-- Generalize the reorder-only idempotency table to cover create/update/delete
-- as well (needed for Stage 9's offline-queue replay). Renamed rather than
-- dropped/recreated so existing idempotency records aren't lost.
ALTER TABLE "ReorderIdempotencyRecord" RENAME TO "OperationIdempotencyRecord";
