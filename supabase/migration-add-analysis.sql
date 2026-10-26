-- ============================================================
-- Migration: store the written REA analysis alongside each property.
-- Run this ONCE in Supabase (SQL Editor → New query → paste → Run)
-- if you already ran the original schema.sql. Safe to run again.
-- ============================================================

alter table properties
  add column if not exists analysis jsonb;

-- 'analysis' holds the six-section report produced from the REA documents:
-- { propertySummary, documentsReviewed[], parties[], controlZones[],
--   approvalMatrix[], evRestrictions[], recommendedZones[], risks[], nextSteps[] }
