-- Explicit abandonment keeps receipts/aliases and permits an intentional new scan.
ALTER TABLE "CatalogReconciliation" DROP CONSTRAINT "CatalogReconciliation_status_check";
ALTER TABLE "CatalogReconciliation" ADD CONSTRAINT "CatalogReconciliation_status_check"
 CHECK(status IN ('ready','waiting','paused','blocked','completed','completed_with_review','cancelled'));
