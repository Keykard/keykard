-- The cardholder can pause every way to pay (phone keys + physical card) on-chain, without touching auto-pay or the
-- credit line; and can choose to publish their credit file at /u/<username>.
ALTER TABLE lines ADD COLUMN IF NOT EXISTS user_frozen BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile BOOLEAN NOT NULL DEFAULT false;
