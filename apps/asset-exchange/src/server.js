import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { ASSET_TYPES } from "./assetTypes.js";
import { HttpError, hmacHex, signJwt, verifyHmac, verifyJwt } from "./auth.js";
import { ROOT, config as defaultConfig } from "./config.js";
import { openDb } from "./db.js";
import { createLedger } from "./ledger.js";

const PUBLIC_DIR = join(ROOT, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const json = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const publicUser = (u) =>
  u && {
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    phone: u.phone,
    role: u.role,
    kyc_status: u.kyc_status,
    bank_name: u.bank_name,
    // Che thông tin nhạy cảm
    bank_account_masked: u.bank_account_number ? `****${u.bank_account_number.slice(-4)}` : null,
    cccd_masked: u.cccd_number ? `********${u.cccd_number.slice(-4)}` : null,
  };

export function createApp({ config = defaultConfig, db = openDb(config.dbPath) } = {}) {
  const ledger = createLedger(db, config);
  const ex = ledger.exchange;

  // Luồng dữ liệu thị trường thời gian thực (Server-Sent Events): báo mã tài sản vừa thay đổi
  const streams = new Set();
  const pending = new Set();
  let flushTimer = null;
  ex.events.on("market", (assetId) => {
    pending.add(assetId);
    flushTimer ??= setTimeout(() => {
      const msg = `event: market\ndata: ${JSON.stringify([...pending])}\n\n`;
      pending.clear();
      flushTimer = null;
      for (const r of streams) r.write(msg);
    }, 150);
  });
  const routes = [];
  const route = (method, pattern, opts, handler) => {
    const keys = [];
    const re = new RegExp(
      `^${pattern.replace(/:(\w+)/g, (_m, k) => {
        keys.push(k);
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, re, keys, opts, handler });
  };

  // Giới hạn tần suất đăng nhập đơn giản (theo IP)
  const attempts = new Map();
  const rateLimit = (key, max = 10, windowMs = 15 * 60 * 1000) => {
    const now = Date.now();
    const rec = attempts.get(key);
    if (!rec || rec.reset < now) {
      attempts.set(key, { n: 1, reset: now + windowMs });
      return;
    }
    if (++rec.n > max) throw new HttpError(429, "Quá nhiều lần thử, vui lòng thử lại sau");
  };

  const assetView = (a) => ({
    ...a,
    metadata: JSON.parse(a.metadata_json),
    tags: JSON.parse(a.tags_json),
    metadata_json: undefined,
    tags_json: undefined,
    type_label: ASSET_TYPES[a.asset_type]?.label,
    last_price: db.get("SELECT price FROM price_history WHERE asset_id = ? ORDER BY id DESC LIMIT 1", a.id)?.price ?? a.token_price,
    // Tỷ suất thu nhập/năm ước tính (bps) = thu nhập cam kết * 12 / định giá
    expected_yield_bps: a.valuation_amount > 0n ? (a.monthly_rent_commitment * 12n * 10000n) / a.valuation_amount : 0n,
  });
  const canSeeUnlisted = (user, a) => user && (user.role === "ADMIN" || user.id === a.owner_id);

  // ---------------- PUBLIC ----------------
  route("GET", "/api/meta", {}, () => ({
    asset_types: ASSET_TYPES,
    allow_bank_simulator: config.allowBankSimulator,
    fees: {
      platform_fee_bps: config.platformFeeBps,
      trade_fee_bps: config.tradeFeeBps,
      sell_tax_bps: config.sellTaxBps,
      dividend_tax_bps: config.dividendTaxBps,
      band_bps: config.bandBps,
      tick_size: config.tickSize,
    },
  }));

  route("POST", "/api/auth/register", {}, ({ body, ip }) => {
    rateLimit(`reg:${ip}`, 20);
    const u = ledger.registerUser(body);
    return { token: signJwt({ sub: u.id }, config.jwtSecret), user: publicUser(u) };
  });

  route("POST", "/api/auth/login", {}, ({ body, ip }) => {
    rateLimit(`login:${ip}`);
    const u = ledger.login(body.email, body.password);
    return { token: signJwt({ sub: u.id }, config.jwtSecret), user: publicUser(u) };
  });

  route("GET", "/api/assets", { optionalAuth: true }, ({ query }) => {
    const where = ["status IN ('FUNDING','ACTIVE','HALTED_PLANNING','DELISTED')"];
    const params = [];
    if (query.get("type") && ASSET_TYPES[query.get("type")]) {
      where.push("asset_type = ?");
      params.push(query.get("type"));
    }
    if (query.get("status")) {
      where.push("status = ?");
      params.push(query.get("status"));
    }
    if (query.get("q")) {
      where.push("(title LIKE ? OR asset_code LIKE ? OR location LIKE ?)");
      const q = `%${query.get("q").slice(0, 50)}%`;
      params.push(q, q, q);
    }
    return db.all(`SELECT * FROM assets WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT 200`, ...params).map(assetView);
  });

  route("GET", "/api/assets/:id", { optionalAuth: true }, ({ params, user }) => {
    const a = db.get("SELECT * FROM assets WHERE id = ? OR asset_code = ?", params.id, params.id);
    if (!a) throw new HttpError(404, "Không tìm thấy tài sản");
    if (["PENDING_REVIEW", "DRAFT"].includes(a.status) && !canSeeUnlisted(user, a)) throw new HttpError(404, "Không tìm thấy tài sản");
    const proposals = db.all("SELECT * FROM governance_proposals WHERE asset_id = ? ORDER BY created_at DESC", a.id).map((p) => ({
      ...p,
      tally: ledger.tally(p, a.total_tokens),
      proposer_name: db.get("SELECT full_name FROM users WHERE id = ?", p.proposer_id)?.full_name,
      my_vote: user ? (db.get("SELECT decision FROM proposal_votes WHERE proposal_id = ? AND user_id = ?", p.id, user.id)?.decision ?? null) : null,
    }));
    const holders = ledger.holders(a.id);
    return {
      ...assetView(a),
      type_def: ASSET_TYPES[a.asset_type],
      spv: a.spv_id ? db.get("SELECT company_name, tax_code, bank_custodian_name, custody_certificate_url FROM spv_entities WHERE id = ?", a.spv_id) : null,
      owner_name: db.get("SELECT full_name FROM users WHERE id = ?", a.owner_id)?.full_name,
      documents: db.all("SELECT id, doc_type, title, url, sha256, redacted FROM asset_documents WHERE asset_id = ?", a.id),
      price_history: db.all("SELECT price, recorded_at FROM price_history WHERE asset_id = ? ORDER BY id", a.id),
      income_reports: db.all("SELECT period, gross_amount, platform_fee, operator_reward, tax_total, net_paid FROM income_reports WHERE asset_id = ? ORDER BY period", a.id),
      proposals,
      market: ["ACTIVE", "HALTED_PLANNING", "DELISTED"].includes(a.status) ? ex.summary(a) : null,
      holder_count: holders.length,
      my_holding: user ? (db.get("SELECT available_tokens, locked_tokens, avg_buy_price FROM user_holdings WHERE user_id = ? AND asset_id = ?", user.id, a.id) ?? null) : null,
    };
  });

  // Webhook ngân hàng: xác thực HMAC-SHA256 trên RAW body
  route("POST", "/api/webhooks/bank-payment", { rawBody: true }, ({ raw, req, res }) => {
    if (!verifyHmac(raw, req.headers["x-signature"], config.webhookSecret)) throw new HttpError(401, "Chữ ký webhook không hợp lệ");
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "JSON không hợp lệ");
    }
    const r = ledger.handleBankPayment(payload);
    res.statusCode = r.status;
    return r;
  });

  // ---------------- AUTH ----------------
  route("GET", "/api/me", { auth: true }, ({ user }) => ({
    user: publicUser(user),
    unread: db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0", user.id).n,
  }));

  route("POST", "/api/me/kyc", { auth: true }, ({ user, body }) => {
    ledger.submitKyc(user.id, body);
    return { ok: true };
  });

  route("GET", "/api/notifications", { auth: true }, ({ user }) =>
    db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100", user.id),
  );
  route("POST", "/api/notifications/read", { auth: true }, ({ user }) => {
    db.run("UPDATE notifications SET is_read = 1 WHERE user_id = ?", user.id);
    return { ok: true };
  });

  route("GET", "/api/portfolio", { auth: true }, ({ user }) => {
    const holdings = db
      .all(
        `SELECT h.available_tokens, h.locked_tokens, h.avg_buy_price, a.id AS asset_id, a.asset_code, a.title, a.asset_type, a.status, a.token_price
           FROM user_holdings h JOIN assets a ON a.id = h.asset_id
          WHERE h.user_id = ? AND h.available_tokens + h.locked_tokens > 0`,
        user.id,
      )
      .map((h) => {
        const last = db.get("SELECT price FROM price_history WHERE asset_id = ? ORDER BY id DESC LIMIT 1", h.asset_id)?.price ?? h.token_price;
        const qty = h.available_tokens + h.locked_tokens;
        return { ...h, last_price: last, market_value: qty * last, cost_basis: qty * h.avg_buy_price };
      });
    const transactions = db.all(
      `SELECT t.id, t.reference_code, t.type, t.token_amount, t.fiat_amount, t.fee_amount, t.tax_amount, t.net_amount, t.status, t.note, t.created_at, a.asset_code
         FROM transactions t LEFT JOIN assets a ON a.id = t.asset_id WHERE t.user_id = ? ORDER BY t.created_at DESC, t.rowid DESC LIMIT 200`,
      user.id,
    );
    const wallet = ex.cash(user.id);
    const securities_value = holdings.reduce((s, h) => s + h.market_value, 0n);
    const cost_total = holdings.reduce((s, h) => s + h.cost_basis, 0n);
    const net_worth = securities_value + wallet.available + wallet.locked;
    const dividends_total = transactions.filter((t) => t.type === "DIVIDEND").reduce((s, t) => s + t.net_amount, 0n);
    return { holdings, transactions, wallet, securities_value, cost_total, net_worth, dividends_total };
  });

  // Giấy xác nhận sở hữu (dấu niêm phong số SHA-256 trên nội dung xác nhận)
  route("GET", "/api/certificates/:assetId", { auth: true }, ({ user, params }) => {
    const a = db.get("SELECT * FROM assets WHERE id = ?", params.assetId);
    const h = a && db.get("SELECT * FROM user_holdings WHERE user_id = ? AND asset_id = ?", user.id, a.id);
    if (!h || h.available_tokens + h.locked_tokens === 0n) throw new HttpError(404, "Bạn không sở hữu tài sản này");
    const spv = a.spv_id ? db.get("SELECT * FROM spv_entities WHERE id = ?", a.spv_id) : null;
    const content = {
      certificate_no: `CERT-${a.asset_code}-${user.id.slice(0, 8).toUpperCase()}`,
      issued_at: new Date().toISOString(),
      holder: { full_name: user.full_name, cccd_masked: publicUser(user).cccd_masked },
      asset: { code: a.asset_code, title: a.title, type: ASSET_TYPES[a.asset_type]?.label, total_tokens: a.total_tokens },
      spv: spv && { company_name: spv.company_name, tax_code: spv.tax_code, custodian: spv.bank_custodian_name },
      tokens: h.available_tokens + h.locked_tokens,
      ownership_bps: ((h.available_tokens + h.locked_tokens) * 10000n) / a.total_tokens,
      audit_head: db.get("SELECT hash FROM audit_logs ORDER BY seq DESC LIMIT 1")?.hash ?? null,
    };
    const seal = createHash("sha256").update(json(content)).digest("hex");
    return { ...content, seal };
  });

  route("POST", "/api/orders/create", { auth: true }, ({ user, body }) =>
    ledger.createPrimaryOrder(user.id, String(body.asset_id || ""), body.token_amount, { fromWallet: body.from_wallet === true }),
  );
  route("GET", "/api/orders/:id", { auth: true }, ({ user, params }) => {
    const t = db.get("SELECT * FROM transactions WHERE id = ? AND user_id = ?", params.id, user.id);
    if (!t) throw new HttpError(404, "Không tìm thấy đơn");
    const asset = t.asset_id ? db.get("SELECT id, asset_code, title FROM assets WHERE id = ?", t.asset_id) : null;
    return {
      id: t.id,
      reference_code: t.reference_code,
      type: t.type,
      token_amount: t.token_amount,
      fiat_amount: t.fiat_amount,
      status: t.status,
      expires_at: t.expires_at,
      asset,
      payment: t.status === "PENDING" ? ledger.paymentInstructions(t) : null,
    };
  });
  route("POST", "/api/orders/:id/cancel", { auth: true }, ({ user, params }) => {
    ledger.cancelOrder(user.id, params.id);
    return { ok: true };
  });

  // ---------------- SÀN GIAO DỊCH ----------------
  const tradable = (id) => {
    const a = db.get("SELECT * FROM assets WHERE id = ? OR asset_code = ?", id, id);
    if (!a || ["PENDING_REVIEW", "DRAFT"].includes(a.status)) throw new HttpError(404, "Không tìm thấy tài sản");
    return a;
  };
  route("GET", "/api/market/board", {}, () =>
    db
      .all("SELECT * FROM assets WHERE status IN ('ACTIVE','HALTED_PLANNING') ORDER BY asset_type, asset_code")
      .map((a) => ({ id: a.id, asset_code: a.asset_code, asset_type: a.asset_type, title: a.title, status: a.status, total_tokens: a.total_tokens, ...ex.summary(a) })),
  );
  route("GET", "/api/market/:id/depth", {}, ({ params }) => ex.depth(tradable(params.id).id, 15));
  route("GET", "/api/market/:id/trades", {}, ({ params, query }) => ex.recentTrades(tradable(params.id).id, query.get("limit")));
  route("GET", "/api/market/:id/candles", {}, ({ params, query }) => ex.candles(tradable(params.id).id, query.get("interval") || "1h", query.get("limit")));
  route("GET", "/api/market/:id/summary", {}, ({ params }) => ex.summary(tradable(params.id)));

  route("POST", "/api/exchange/orders", { auth: true }, ({ user, body }) => ex.placeOrder(user.id, body));
  route("GET", "/api/exchange/orders", { auth: true }, ({ user, query }) => {
    const open = query.get("status") !== "history";
    const assetId = query.get("asset_id");
    return db.all(
      `SELECT o.*, a.asset_code FROM orders o JOIN assets a ON a.id = o.asset_id
        WHERE o.user_id = ? AND ${open ? "o.status IN ('OPEN','PARTIAL','PENDING_TRIGGER')" : "o.status IN ('FILLED','CANCELLED')"}
          ${assetId ? "AND o.asset_id = ?" : ""}
        ORDER BY o.rowid DESC LIMIT 100`,
      user.id,
      ...(assetId ? [assetId] : []),
    );
  });
  route("GET", "/api/exchange/balance", { auth: true }, ({ user, query }) => {
    const assetId = query.get("asset_id") || "";
    return {
      cash: ex.cash(user.id),
      holding: db.get("SELECT available_tokens, locked_tokens, avg_buy_price FROM user_holdings WHERE user_id = ? AND asset_id = ?", user.id, assetId) ?? {
        available_tokens: 0n,
        locked_tokens: 0n,
        avg_buy_price: 0n,
      },
    };
  });
  route("POST", "/api/exchange/orders/:id/cancel", { auth: true }, ({ user, params }) => {
    ex.cancelOrder(user.id, params.id);
    return { ok: true };
  });
  route("GET", "/api/exchange/my-trades", { auth: true }, ({ user }) =>
    db.all(
      `SELECT t.id, t.price, t.quantity, t.created_at, a.asset_code,
              CASE WHEN t.buyer_id = ? THEN 'BUY' ELSE 'SELL' END AS side,
              CASE WHEN t.buyer_id = ? THEN t.buyer_fee ELSE t.seller_fee END AS fee,
              CASE WHEN t.buyer_id = ? THEN 0 ELSE t.seller_tax END AS tax
         FROM trades t JOIN assets a ON a.id = t.asset_id WHERE t.buyer_id = ? OR t.seller_id = ? ORDER BY t.id DESC LIMIT 200`,
      user.id,
      user.id,
      user.id,
      user.id,
      user.id,
    ),
  );

  route("GET", "/api/wallet", { auth: true }, ({ user }) => ({
    ...ex.cash(user.id),
    bank_name: user.bank_name,
    bank_account_masked: publicUser(user).bank_account_masked,
    history: db.all(
      "SELECT id, reference_code, type, fiat_amount, status, created_at FROM transactions WHERE user_id = ? AND type IN ('DEPOSIT','WITHDRAWAL') ORDER BY rowid DESC LIMIT 50",
      user.id,
    ),
  }));
  route("POST", "/api/wallet/deposit", { auth: true }, ({ user, body }) => ex.createDeposit(user.id, body.amount));
  route("POST", "/api/wallet/withdraw", { auth: true }, ({ user, body }) => ex.requestWithdrawal(user.id, body.amount));

  route("GET", "/api/alerts", { auth: true }, ({ user }) =>
    db.all(
      "SELECT al.*, a.asset_code FROM price_alerts al JOIN assets a ON a.id = al.asset_id WHERE al.user_id = ? ORDER BY al.active DESC, al.created_at DESC LIMIT 100",
      user.id,
    ),
  );
  route("POST", "/api/alerts", { auth: true }, ({ user, body }) => ({ id: ex.createAlert(user.id, String(body.asset_id || ""), body.direction, body.price) }));
  route("POST", "/api/alerts/:id/delete", { auth: true }, ({ user, params }) => {
    ex.deleteAlert(user.id, params.id);
    return { ok: true };
  });

  route("POST", "/api/assets", { auth: true, roles: ["OWNER", "ADMIN"] }, ({ user, body }) => assetView(ledger.submitAsset(user.id, body)));
  route("GET", "/api/my-assets", { auth: true }, ({ user }) => db.all("SELECT * FROM assets WHERE owner_id = ? ORDER BY created_at DESC", user.id).map(assetView));

  route("POST", "/api/assets/:id/proposals", { auth: true }, ({ user, params, body }) => ({ id: ledger.createProposal(user.id, params.id, body) }));
  route("POST", "/api/proposals/:id/vote", { auth: true }, ({ user, params, body }) => ledger.castVote(params.id, user.id, body.decision));

  // Mô phỏng ngân hàng (CHỈ môi trường dev): ký HMAC phía server rồi gọi đúng luồng webhook
  route("POST", "/api/dev/simulate-payment", { auth: true }, ({ user, body }) => {
    if (!config.allowBankSimulator) throw new HttpError(404, "Not found");
    const t = db.get("SELECT * FROM transactions WHERE id = ?", String(body.transaction_id || ""));
    if (!t || (t.user_id !== user.id && user.role !== "ADMIN")) throw new HttpError(404, "Không tìm thấy đơn");
    const raw = json({ reference_code: t.reference_code, amount: t.fiat_amount, bank_txn_id: `SIM-${Date.now()}` });
    if (!verifyHmac(raw, hmacHex(raw, config.webhookSecret), config.webhookSecret)) throw new HttpError(500, "HMAC error");
    return ledger.handleBankPayment(JSON.parse(raw));
  });

  // ---------------- ADMIN ----------------
  const admin = { auth: true, roles: ["ADMIN"] };
  route("GET", "/api/admin/overview", admin, () => ({
    pending_kyc: db.all("SELECT * FROM users WHERE kyc_status = 'PENDING'").map((u) => ({ ...publicUser(u), cccd_number: u.cccd_number })),
    assets: db.all("SELECT * FROM assets ORDER BY created_at DESC").map(assetView),
    spvs: db.all("SELECT * FROM spv_entities"),
    batches: db.all(
      "SELECT b.*, a.asset_code FROM payout_batches b LEFT JOIN assets a ON a.id = b.asset_id ORDER BY b.created_at DESC, b.rowid DESC LIMIT 100",
    ),
    proposals: db.all(
      "SELECT p.*, a.asset_code FROM governance_proposals p JOIN assets a ON a.id = p.asset_id WHERE p.status = 'APPROVED' AND p.proposal_type <> 'VALUE_ADD_5_10_PERCENT'",
    ),
    stats: {
      users: db.get("SELECT COUNT(*) AS n FROM users").n,
      escrow_inflow: db.get("SELECT COALESCE(SUM(fiat_amount),0) AS s FROM transactions WHERE status = 'COMPLETED' AND type IN ('BUY_PRIMARY','DEPOSIT')").s,
      trade_value: db.get("SELECT COALESCE(SUM(price*quantity),0) AS s FROM trades").s,
      fee_revenue: db.get("SELECT COALESCE(SUM(buyer_fee+seller_fee),0) AS s FROM trades").s,
      pending_payout: db.get("SELECT COALESCE(SUM(total_amount),0) AS s FROM payout_batches WHERE status = 'PENDING_APPROVAL'").s,
    },
  }));
  route("POST", "/api/admin/kyc/:userId", admin, ({ user, params, body }) => {
    ledger.reviewKyc(user.id, params.userId, body.approve === true);
    return { ok: true };
  });
  route("POST", "/api/admin/spv", admin, ({ user, body }) => ({ id: ledger.createSpv(user.id, body) }));
  route("POST", "/api/admin/assets/:id/approve", admin, ({ user, params, body }) => {
    ledger.approveAsset(user.id, params.id, body);
    return { ok: true };
  });
  route("POST", "/api/admin/assets/:id/reject", admin, ({ user, params, body }) => {
    ledger.rejectAsset(user.id, params.id, body.reason);
    return { ok: true };
  });
  route("POST", "/api/admin/assets/:id/activate", admin, ({ user, params }) => ledger.activateAsset(user.id, params.id));
  route("POST", "/api/admin/assets/:id/fail-funding", admin, ({ user, params }) => ledger.failFunding(user.id, params.id));
  route("POST", "/api/admin/assets/:id/rent/preview", admin, ({ params, body }) => ledger.previewRentDistribution(params.id, body.gross_amount));
  route("POST", "/api/admin/assets/:id/rent/distribute", admin, ({ user, params, body }) =>
    ledger.distributeMonthlyRent(user.id, params.id, body.gross_amount, { period: body.period, fromReserve: body.from_reserve === true }),
  );
  route("POST", "/api/admin/assets/:id/halt", admin, ({ user, params, body }) => {
    ledger.triggerPlanningHalt(user.id, params.id, body.notice_url);
    return { ok: true };
  });
  route("POST", "/api/admin/assets/:id/resume", admin, ({ user, params }) => {
    ledger.resumeTrading(user.id, params.id);
    return { ok: true };
  });
  route("POST", "/api/admin/assets/:id/exit/preview", admin, ({ params, body }) => ledger.calculateExitPayout(params.id, body.final_sale_price));
  route("POST", "/api/admin/assets/:id/exit/execute", admin, ({ user, params, body }) => ledger.executeExit(user.id, params.id, body.final_sale_price));
  route("POST", "/api/admin/proposals/:id/buyback", admin, ({ user, params }) => ledger.executeBuyback(user.id, params.id));
  route("GET", "/api/admin/batches/:id/csv", admin, ({ params, res }) => {
    if (!db.get("SELECT 1 FROM payout_batches WHERE id = ?", params.id)) throw new HttpError(404, "Không tìm thấy bảng kê");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="payout-${params.id.slice(0, 8)}.csv"`,
    });
    res.end(ledger.batchCsv(params.id));
    return undefined;
  });
  route("POST", "/api/admin/batches/:id/paid", admin, ({ user, params }) => {
    ledger.markBatchPaid(user.id, params.id);
    return { ok: true };
  });
  route("GET", "/api/admin/audit", admin, () => ({
    chain: db.verifyAuditChain(),
    logs: db.all("SELECT * FROM audit_logs ORDER BY seq DESC LIMIT 200"),
  }));

  // ---------------- HTTP plumbing ----------------
  async function readBody(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new HttpError(413, "Dữ liệu gửi lên quá lớn");
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  function authUser(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) return null;
    const payload = verifyJwt(m[1], config.jwtSecret);
    if (!payload) return null;
    // Luôn lấy định danh & vai trò từ token đã ký + DB, KHÔNG BAO GIỜ tin user_id từ client
    return db.get("SELECT * FROM users WHERE id = ?", payload.sub) ?? null;
  }

  async function serveStatic(req, res, pathname) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + sep) && file !== PUBLIC_DIR) {
      res.writeHead(403).end();
      return;
    }
    if (file === PUBLIC_DIR || rel === "/" || !extname(file)) file = join(PUBLIC_DIR, "index.html");
    try {
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
  }

  async function handler(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/stream" && req.method === "GET") {
      if (streams.size > 1000) return res.writeHead(503).end();
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write("retry: 3000\n\n");
      streams.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ping);
        streams.delete(res);
      });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
      return serveStatic(req, res, url.pathname);
    }
    try {
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, "Không tìm thấy API");
      const match = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(match[i + 1])]));
      let user = null;
      if (r.opts.auth || r.opts.optionalAuth) user = authUser(req);
      if (r.opts.auth && !user) throw new HttpError(401, "Vui lòng đăng nhập");
      if (r.opts.roles && !r.opts.roles.includes(user.role)) throw new HttpError(403, "Không có quyền truy cập");
      let body = {};
      let raw = "";
      if (req.method === "POST") {
        raw = await readBody(req);
        if (!r.opts.rawBody && raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            throw new HttpError(400, "JSON không hợp lệ");
          }
          if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body phải là object");
        }
      }
      const ip = req.socket.remoteAddress || "unknown";
      const out = await r.handler({ req, res, params, query: url.searchParams, body, raw, user, ip });
      if (res.writableEnded) return;
      if (!res.headersSent) res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(json(out ?? { ok: true }));
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(json({ error: status === 500 ? "Lỗi hệ thống" : e.message, code: e.code }));
    }
  }

  return { handler, db, ledger };
}

// Chạy trực tiếp: node src/server.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { handler, ledger, db } = createApp();
  if (!db.get("SELECT 1 FROM users LIMIT 1")) {
    const { seed } = await import("./seed.js");
    seed(ledger, db);
    console.log("Đã khởi tạo dữ liệu mẫu (xem README để biết tài khoản demo).");
  }
  // Dọn đơn quá hạn & đóng biểu quyết hết hạn mỗi phút
  setInterval(() => {
    try {
      ledger.expireStaleOrders();
      ledger.closeExpiredProposals();
    } catch (e) {
      console.error(e);
    }
  }, 60_000).unref();
  createServer(handler).listen(defaultConfig.port, () => {
    console.log(`Asset Exchange chạy tại http://localhost:${defaultConfig.port}`);
  });
}
