-- Burn-for-compute credits. Money is integer micro-USD (1 USD = 1,000,000) everywhere.
--
-- Balance rule: workspaces.balance_micro_usd is the SPENDABLE balance. reserve() moves money out of it
-- into an active reservation in the same statement that checks it, so the CHECK (balance >= 0) means
-- active reservations can never exceed what was credited. Total held = balance + SUM(active reservations).

CREATE TABLE workspaces (
  id                text PRIMARY KEY CHECK (id ~ '^ws_[A-Za-z0-9]{16,32}$'),
  label             text NOT NULL DEFAULT '' CHECK (char_length(label) <= 64),
  key_hash          text NOT NULL UNIQUE,
  balance_micro_usd bigint NOT NULL DEFAULT 0 CHECK (balance_micro_usd >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_ip_hash   text
);

-- Every credit, append only. (reason, ref) is unique so one burn can never credit twice.
CREATE TABLE credit_ledger (
  id              bigserial PRIMARY KEY,
  workspace_id    text NOT NULL REFERENCES workspaces(id),
  delta_micro_usd bigint NOT NULL CHECK (delta_micro_usd > 0),
  reason          text NOT NULL CHECK (reason IN ('burn', 'grant')),
  ref             text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reason, ref)
);
CREATE INDEX credit_ledger_workspace ON credit_ledger (workspace_id, created_at DESC);

-- Verified on-chain burns. The signature primary key is the idempotency key.
CREATE TABLE burns (
  signature        text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id),
  owner            text NOT NULL,
  mint             text NOT NULL,
  amount_raw       numeric(40, 0) NOT NULL CHECK (amount_raw > 0),
  decimals         smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  amount_ui        numeric NOT NULL,
  price_usd        numeric NOT NULL CHECK (price_usd > 0),
  usd_value        numeric NOT NULL,
  credit_micro_usd bigint NOT NULL CHECK (credit_micro_usd >= 0),
  -- credited: added to the balance. review: above the per-burn cap, held for a human, nothing credited.
  status           text NOT NULL CHECK (status IN ('credited', 'review')),
  slot             bigint NOT NULL,
  block_time       timestamptz NOT NULL,
  verified_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX burns_ledger_order ON burns (block_time DESC, signature DESC);
CREATE INDEX burns_workspace ON burns (workspace_id, block_time DESC);

CREATE TABLE reservations (
  id               text PRIMARY KEY,
  workspace_id     text NOT NULL REFERENCES workspaces(id),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd > 0),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'settled', 'expired')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  settled_at       timestamptz,
  CHECK ((status = 'active') = (settled_at IS NULL))
);
CREATE INDEX reservations_active ON reservations (created_at) WHERE status = 'active';

-- One row per settled reservation (reservation_id unique: usage is recorded exactly once).
CREATE TABLE usage (
  id             bigserial PRIMARY KEY,
  workspace_id   text NOT NULL REFERENCES workspaces(id),
  reservation_id text NOT NULL UNIQUE REFERENCES reservations(id),
  model          text NOT NULL,
  input_tokens   integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens  integer NOT NULL CHECK (output_tokens >= 0),
  cost_micro_usd bigint NOT NULL CHECK (cost_micro_usd >= 0),
  status         text NOT NULL CHECK (status IN ('ok', 'error', 'expired')),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_workspace ON usage (workspace_id, created_at DESC);

CREATE TABLE price_samples (
  id        bigserial PRIMARY KEY,
  mint      text NOT NULL,
  ts        timestamptz NOT NULL,
  price_usd numeric NOT NULL CHECK (price_usd > 0),
  source    text NOT NULL
);
CREATE INDEX price_samples_mint_ts ON price_samples (mint, ts);

-- Fixed-window counters. key is "<bucket>:<subject>", subject is a hash for IPs.
CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
