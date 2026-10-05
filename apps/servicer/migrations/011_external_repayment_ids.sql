-- A small, stable sequence number per incoming repayment, used in its transfer memos (movements.seq is INT).
ALTER TABLE external_repayments ADD COLUMN IF NOT EXISTS id BIGSERIAL;
CREATE UNIQUE INDEX IF NOT EXISTS external_repayments_id_idx ON external_repayments (id);
