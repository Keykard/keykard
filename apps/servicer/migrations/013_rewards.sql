-- Rewards, funded the way card networks fund them (see contracts-free accounting in rewards.ts):
--   * a merchant fee on each card payment (1% standard, overridable per merchant), part of it returned as 0.5% cashback
--   * merchant-funded offers ("10% back"), paid out of the merchant's own payout, capped by a budget
--   * a fee shield: 3 on-time bills in a row cancel the next late fee
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS fee_bps INT;                 -- NULL = the standard fee (MERCHANT_FEE_BPS)

CREATE TABLE IF NOT EXISTS merchant_offers (
  id              BIGSERIAL PRIMARY KEY,
  merchant_code   TEXT NOT NULL REFERENCES merchants(code),
  pct_bps         INT NOT NULL CHECK (pct_bps BETWEEN 1 AND 5000),       -- share of each payment given back
  max_per_payment NUMERIC(78,0) NOT NULL CHECK (max_per_payment > 0),
  budget          NUMERIC(78,0) NOT NULL CHECK (budget > 0),
  spent           NUMERIC(78,0) NOT NULL DEFAULT 0,
  ends_at         TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_offer_per_merchant ON merchant_offers (merchant_code) WHERE status IN ('active','paused');

-- how each card payment split (gross = amount)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee              NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS merchant_net     NUMERIC(78,0);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS base_cashback    NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS offer_cashback   NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS offer_id         BIGINT REFERENCES merchant_offers(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashback_status  TEXT NOT NULL DEFAULT 'none'; -- none|pending|paid|failed
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashback_to_card NUMERIC(78,0) NOT NULL DEFAULT 0; -- part that paid down the bill
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashback_to_wallet NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS cashback_tx      TEXT;
CREATE INDEX IF NOT EXISTS payments_cashback_idx ON payments (cashback_status) WHERE cashback_status IN ('pending','failed');

ALTER TABLE lines ADD COLUMN IF NOT EXISTS on_time_streak INT NOT NULL DEFAULT 0;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS fee_shields    INT NOT NULL DEFAULT 0;   -- 0 or 1
