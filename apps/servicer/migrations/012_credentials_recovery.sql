-- One account, several keys on the same wallet (Tempo TIP-1049 admin keys):
--   password  : a secp256k1 key the user's password encrypts (client-side); the wallet's root for new accounts
--   passkey   : WebAuthn (fingerprint / face); an admin key, or the root for accounts created passkey-first
--   recovery  : a KEYKARD-held admin key, used ONLY to restore access after Self re-verification + a waiting period
CREATE TABLE IF NOT EXISTS credentials (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL REFERENCES users(wallet),
  kind        TEXT NOT NULL CHECK (kind IN ('password','passkey','recovery')),
  key_id      TEXT NOT NULL,                 -- the key's address on Tempo (the wallet itself for the root)
  is_root     BOOLEAN NOT NULL DEFAULT false,
  passkey_id  TEXT,                          -- WebAuthn credential id (passkeys)
  public_key  TEXT,                          -- WebAuthn P-256 public key (passkeys)
  sealed_key  TEXT,                          -- recovery key, AES-256-GCM sealed
  pending     JSONB,                         -- a new password key's encrypted vault + login proof, until it is on-chain
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','revoked','retired')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet, key_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS credentials_passkey_idx ON credentials (passkey_id) WHERE passkey_id IS NOT NULL AND status IN ('pending','active');
CREATE INDEX IF NOT EXISTS credentials_wallet_idx ON credentials (wallet, status);

-- existing accounts: their single key is the root
INSERT INTO credentials (wallet, kind, key_id, is_root, passkey_id, public_key, status)
SELECT u.wallet,
       CASE WHEN u.key_type = 'secp256k1' THEN 'password' ELSE 'passkey' END,
       u.wallet, true,
       CASE WHEN u.key_type = 'secp256k1' THEN NULL ELSE u.passkey_id END,
       CASE WHEN u.key_type = 'secp256k1' THEN NULL ELSE u.passkey_public_key END,
       'active'
FROM users u
ON CONFLICT (wallet, key_id) DO NOTHING;

-- users who turned account recovery off (fully self-custodial)
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_opt_out BOOLEAN NOT NULL DEFAULT false;
-- which credential a password vault unlocks (the root for older accounts)
ALTER TABLE password_logins ADD COLUMN IF NOT EXISTS key_id TEXT;
UPDATE password_logins SET key_id = wallet WHERE key_id IS NULL;

-- Every key the user signs card payments with is a spend key on their credit account.
CREATE TABLE IF NOT EXISTS line_spend_keys (
  line_id     BIGINT NOT NULL REFERENCES lines(id),
  key_id      TEXT NOT NULL,
  credential_id BIGINT REFERENCES credentials(id),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (line_id, key_id)
);
INSERT INTO line_spend_keys (line_id, key_id)
SELECT id, spend_key_id FROM lines WHERE spend_key_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- "Lost my password AND my passkey": restore access to the SAME wallet after Self re-verification + a wait.
CREATE TABLE IF NOT EXISTS recoveries (
  id              TEXT PRIMARY KEY,
  wallet          TEXT NOT NULL REFERENCES users(wallet),
  status          TEXT NOT NULL DEFAULT 'awaiting_self' CHECK (status IN ('awaiting_self','waiting','completed','cancelled','failed')),
  self_session_id TEXT,
  new_password_key TEXT NOT NULL,            -- address of the new password key (created on the user's device)
  new_vault       JSONB NOT NULL,            -- the new key, encrypted client-side with the new password
  new_auth_proof  TEXT NOT NULL,             -- login proof for the new password (hashed when applied)
  new_passkey_id  TEXT,
  new_passkey_public_key TEXT,
  ready_at        TIMESTAMPTZ,
  completed_tx    TEXT,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_recovery ON recoveries (wallet) WHERE status IN ('awaiting_self','waiting');

ALTER TABLE self_sessions ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'verify';
ALTER TABLE self_sessions ADD COLUMN IF NOT EXISTS recovery_id TEXT;
