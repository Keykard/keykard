-- Pricing for missed payments (late fee + penalty interest, capped; see contracts/src/CreditTerms.sol),
-- a personal repayment address per line (repay from any wallet or exchange), and 1:1 secured lines.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS fees_due        NUMERIC(78,0) NOT NULL DEFAULT 0; -- charged, not yet paid
ALTER TABLE lines ADD COLUMN IF NOT EXISTS fees_charged    NUMERIC(78,0) NOT NULL DEFAULT 0; -- lifetime
ALTER TABLE lines ADD COLUMN IF NOT EXISTS fees_paid       NUMERIC(78,0) NOT NULL DEFAULT 0; -- lifetime
ALTER TABLE lines ADD COLUMN IF NOT EXISTS last_penalty_at TIMESTAMPTZ;                      -- next penalty one period later
ALTER TABLE lines ADD COLUMN IF NOT EXISTS repay_account     TEXT UNIQUE;                    -- send here from anywhere to repay
ALTER TABLE lines ADD COLUMN IF NOT EXISTS repay_account_enc TEXT;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS secured         NUMERIC(78,0) NOT NULL DEFAULT 0; -- collateral locked = extra limit
ALTER TABLE lines ADD COLUMN IF NOT EXISTS pending_mandate_cap NUMERIC(78,0);

ALTER TABLE movements DROP CONSTRAINT IF EXISTS movements_kind_check;
ALTER TABLE movements ADD CONSTRAINT movements_kind_check
  CHECK (kind IN ('FUND','INST','GUAR','TOPUP','EXT','REFUND','SEIZE'));

CREATE TABLE IF NOT EXISTS line_charges (
  id          BIGSERIAL PRIMARY KEY,
  line_id     BIGINT NOT NULL REFERENCES lines(id),
  kind        TEXT NOT NULL CHECK (kind IN ('late_fee','penalty')),
  amount      NUMERIC(78,0) NOT NULL,
  overdue     NUMERIC(78,0) NOT NULL,
  tx_hash     TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS line_charges_line_idx ON line_charges (line_id, created_at);

-- Money that arrived at a line's repayment address; applied once, in order.
CREATE TABLE IF NOT EXISTS external_repayments (
  tx_hash      TEXT NOT NULL,
  log_index    INT NOT NULL,
  line_id      BIGINT NOT NULL REFERENCES lines(id),
  from_addr    TEXT NOT NULL,
  amount       NUMERIC(78,0) NOT NULL,
  block_number BIGINT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'received', -- received|applied|failed
  applied      JSONB,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS external_repayments_status_idx ON external_repayments (status, created_at);
