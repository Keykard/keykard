-- Collateral that earns: the part of a line's secured limit backed by Tempo Earn shares (locked in the second
-- CollateralVault), how many shares are locked, and what the borrower put in (to show what it has earned).
ALTER TABLE lines ADD COLUMN IF NOT EXISTS secured_earn NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS earn_shares NUMERIC(78,0) NOT NULL DEFAULT 0;
ALTER TABLE lines ADD COLUMN IF NOT EXISTS earn_principal NUMERIC(78,0) NOT NULL DEFAULT 0;
