import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Quy ước: mọi số tiền (VND) và số token lưu INTEGER (int64) và đọc ra dưới dạng BigInt.
// Không bao giờ dùng số thực cho tiền. Tỷ lệ % lưu dạng basis points (1% = 100 bps).
const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  cccd_number TEXT,
  kyc_status TEXT NOT NULL DEFAULT 'UNSUBMITTED'
    CHECK (kyc_status IN ('UNSUBMITTED','PENDING','VERIFIED','REJECTED')),
  bank_account_number TEXT,
  bank_name TEXT,
  role TEXT NOT NULL DEFAULT 'INVESTOR' CHECK (role IN ('INVESTOR','OWNER','ADMIN')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spv_entities (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  tax_code TEXT NOT NULL UNIQUE,
  bank_custodian_name TEXT NOT NULL,
  custody_certificate_url TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISSOLVED'))
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  asset_code TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL,
  spv_id TEXT REFERENCES spv_entities(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  tags_json TEXT NOT NULL DEFAULT '[]',
  valuation_amount INTEGER NOT NULL CHECK (valuation_amount > 0),
  token_price INTEGER NOT NULL DEFAULT 10000 CHECK (token_price > 0),
  total_tokens INTEGER NOT NULL CHECK (total_tokens > 0),
  min_funding_tokens INTEGER NOT NULL CHECK (min_funding_tokens > 0),
  sold_tokens INTEGER NOT NULL DEFAULT 0 CHECK (sold_tokens >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  is_sale_leaseback INTEGER NOT NULL DEFAULT 0,
  monthly_rent_commitment INTEGER NOT NULL DEFAULT 0 CHECK (monthly_rent_commitment >= 0),
  rent_escrow_balance INTEGER NOT NULL DEFAULT 0 CHECK (rent_escrow_balance >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW' CHECK (status IN
    ('PENDING_REVIEW','DRAFT','FUNDING','ACTIVE','HALTED_PLANNING','FUNDING_FAILED','DELISTED')),
  halt_notice_url TEXT,
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (sold_tokens + reserved_tokens <= total_tokens),
  CHECK (min_funding_tokens <= total_tokens)
);

CREATE TABLE IF NOT EXISTS asset_documents (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  sha256 TEXT,
  redacted INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  available_tokens INTEGER NOT NULL DEFAULT 0 CHECK (available_tokens >= 0),
  locked_tokens INTEGER NOT NULL DEFAULT 0 CHECK (locked_tokens >= 0),
  avg_buy_price INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, asset_id)
);

CREATE TABLE IF NOT EXISTS otc_listings (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  seller_id TEXT NOT NULL REFERENCES users(id),
  token_amount INTEGER NOT NULL CHECK (token_amount > 0),
  remaining_tokens INTEGER NOT NULL CHECK (remaining_tokens >= 0),
  reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  price_per_token INTEGER NOT NULL CHECK (price_per_token > 0),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','FILLED','CANCELLED')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (reserved_tokens <= remaining_tokens)
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  reference_code TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  asset_id TEXT NOT NULL REFERENCES assets(id),
  type TEXT NOT NULL CHECK (type IN
    ('BUY_PRIMARY','BUY_OTC','SELL_OTC','DIVIDEND','RENT_PAYMENT','REFUND','EXIT_PAYOUT','OWNER_DISBURSEMENT')),
  token_amount INTEGER NOT NULL DEFAULT 0,
  fiat_amount INTEGER NOT NULL DEFAULT 0,
  fee_amount INTEGER NOT NULL DEFAULT 0,
  tax_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER NOT NULL DEFAULT 0,
  listing_id TEXT REFERENCES otc_listings(id),
  batch_id TEXT,
  bank_txn_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN
    ('PENDING','COMPLETED','FAILED','REFUNDED','EXPIRED','CANCELLED','AWAITING_PAYOUT')),
  note TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_tx_asset ON transactions(asset_id, type, status);

CREATE TABLE IF NOT EXISTS governance_proposals (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  proposer_id TEXT NOT NULL REFERENCES users(id),
  proposal_type TEXT NOT NULL CHECK (proposal_type IN
    ('VALUE_ADD_5_10_PERCENT','FULL_EXIT_SALE','BUYBACK_DELISTING')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  proposed_price INTEGER NOT NULL DEFAULT 0,
  reward_bps INTEGER NOT NULL DEFAULT 0 CHECK (reward_bps BETWEEN 0 AND 1000),
  base_income INTEGER NOT NULL DEFAULT 0,
  approval_threshold_bps INTEGER NOT NULL DEFAULT 7500,
  status TEXT NOT NULL DEFAULT 'VOTING' CHECK (status IN ('VOTING','APPROVED','REJECTED','EXECUTED')),
  deadline TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  executed_at TEXT
);

CREATE TABLE IF NOT EXISTS proposal_votes (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES governance_proposals(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  vote_weight_tokens INTEGER NOT NULL CHECK (vote_weight_tokens > 0),
  decision TEXT NOT NULL CHECK (decision IN ('AGREE','DISAGREE')),
  signed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (proposal_id, user_id)
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  price INTEGER NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS income_reports (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  period TEXT NOT NULL,
  gross_amount INTEGER NOT NULL,
  platform_fee INTEGER NOT NULL,
  operator_reward INTEGER NOT NULL,
  tax_total INTEGER NOT NULL,
  net_paid INTEGER NOT NULL,
  dust INTEGER NOT NULL,
  from_reserve INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (asset_id, period)
);

CREATE TABLE IF NOT EXISTS payout_batches (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id),
  kind TEXT NOT NULL CHECK (kind IN ('DIVIDEND','EXIT','REFUND','OTC','OWNER_DISBURSEMENT','BUYBACK')),
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL' CHECK (status IN ('PENDING_APPROVAL','PAID')),
  total_amount INTEGER NOT NULL,
  line_count INTEGER NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Nhật ký kiểm toán BẤT BIẾN, có chuỗi băm (hash chain) để phát hiện sửa đổi.
CREATE TABLE IF NOT EXISTS audit_logs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'audit_logs is append-only'); END;
`;

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return wrap(db);
}

function toParam(v) {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v === undefined) return null;
  return v;
}

// Lớp bọc nhỏ: statement cache, đọc BigInt, transaction ghi độc quyền.
function wrap(raw) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      s.setReadBigInts(true);
      cache.set(sql, s);
    }
    return s;
  };
  let depth = 0;
  const db = {
    raw,
    get: (sql, ...p) => stmt(sql).get(...p.map(toParam)),
    all: (sql, ...p) => stmt(sql).all(...p.map(toParam)),
    run: (sql, ...p) => stmt(sql).run(...p.map(toParam)),
    exec: (sql) => raw.exec(sql),
    /**
     * Chạy fn trong một transaction. BEGIN IMMEDIATE giành khóa ghi toàn cơ sở dữ liệu
     * ngay từ đầu — tương đương (và chặt hơn) SELECT ... FOR UPDATE trên PostgreSQL,
     * nên mọi thao tác đọc-kiểm tra-ghi số dư đều được tuần tự hóa, chống race condition.
     */
    tx(fn) {
      if (depth > 0) return fn();
      raw.exec("BEGIN IMMEDIATE");
      depth++;
      try {
        const out = fn();
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      } finally {
        depth--;
      }
    },
    audit(actorId, action, entity, entityId, data = {}) {
      const prev = db.get("SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1");
      const prevHash = prev ? prev.hash : "GENESIS";
      const dataJson = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      const createdAt = new Date().toISOString();
      const hash = createHash("sha256")
        .update([prevHash, actorId ?? "", action, entity, entityId ?? "", dataJson, createdAt].join("|"))
        .digest("hex");
      db.run(
        "INSERT INTO audit_logs (actor_id, action, entity, entity_id, data_json, prev_hash, hash, created_at) VALUES (?,?,?,?,?,?,?,?)",
        actorId,
        action,
        entity,
        entityId,
        dataJson,
        prevHash,
        hash,
        createdAt,
      );
    },
    verifyAuditChain() {
      let prevHash = "GENESIS";
      for (const r of db.all("SELECT * FROM audit_logs ORDER BY seq")) {
        const h = createHash("sha256")
          .update([prevHash, r.actor_id ?? "", r.action, r.entity, r.entity_id ?? "", r.data_json, r.created_at].join("|"))
          .digest("hex");
        if (r.prev_hash !== prevHash || r.hash !== h) return { ok: false, brokenAt: Number(r.seq) };
        prevHash = r.hash;
      }
      return { ok: true };
    },
    notify(userId, title, body, severity = "INFO") {
      db.run(
        "INSERT INTO notifications (id, user_id, title, body, severity) VALUES (?,?,?,?,?)",
        randomUUID(),
        userId,
        title,
        body,
        severity,
      );
    },
  };
  return db;
}
