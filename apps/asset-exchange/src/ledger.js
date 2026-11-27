// LÕI SỔ CÁI (Sub-ledger Core)
// Mọi thao tác thay đổi số dư token / dòng tiền đều chạy trong db.tx() (khóa ghi độc quyền)
// và ghi nhật ký kiểm toán bất biến. Mọi số tiền / token là BigInt.
import { randomBytes, randomUUID } from "node:crypto";
import { ASSET_TYPES, isAssetType } from "./assetTypes.js";
import { HttpError, hashPassword, verifyPassword } from "./auth.js";
import { createExchange } from "./exchange.js";

const BPS = 10000n;

export function toBig(value, name, { min = 1n, max } = {}) {
  let v;
  if (typeof value === "bigint") v = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) v = BigInt(value);
  else if (typeof value === "string" && /^\d{1,18}$/.test(value.trim())) v = BigInt(value.trim());
  else throw new HttpError(400, `${name} phải là số nguyên không âm`);
  if (v < min) throw new HttpError(400, `${name} phải >= ${min}`);
  if (max !== undefined && v > max) throw new HttpError(400, `${name} phải <= ${max}`);
  return v;
}

function str(value, name, { max = 500, required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new HttpError(400, `Thiếu ${name}`);
    return "";
  }
  const s = String(value).trim();
  if (s.length > max) throw new HttpError(400, `${name} quá dài (tối đa ${max} ký tự)`);
  return s;
}

function safeUrl(value, name) {
  const s = str(value, name, { max: 1000, required: false });
  if (!s) return "";
  if (s.startsWith("/")) return s;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
  } catch {}
  throw new HttpError(400, `${name} không phải URL hợp lệ`);
}

const sqlTime = (d) => new Date(d).toISOString().replace("T", " ").slice(0, 19);
const refCode = (prefix) => `${prefix}${randomBytes(5).toString("hex").toUpperCase()}`;
const minBig = (a, b) => (a < b ? a : b);

export function createLedger(db, config) {
  // ---------- tiện ích nội bộ ----------
  const getAsset = (id) => {
    const a = db.get("SELECT * FROM assets WHERE id = ?", id);
    if (!a) throw new HttpError(404, "Không tìm thấy tài sản");
    return a;
  };
  const getUser = (id) => {
    const u = db.get("SELECT * FROM users WHERE id = ?", id);
    if (!u) throw new HttpError(404, "Không tìm thấy người dùng");
    return u;
  };
  const requireKyc = (userId) => {
    if (getUser(userId).kyc_status !== "VERIFIED") {
      throw new HttpError(403, "Tài khoản chưa xác thực eKYC", "KYC_REQUIRED");
    }
  };
  const holding = (userId, assetId) => {
    let h = db.get("SELECT * FROM user_holdings WHERE user_id = ? AND asset_id = ?", userId, assetId);
    if (!h) {
      db.run("INSERT INTO user_holdings (id, user_id, asset_id) VALUES (?,?,?)", randomUUID(), userId, assetId);
      h = db.get("SELECT * FROM user_holdings WHERE user_id = ? AND asset_id = ?", userId, assetId);
    }
    return h;
  };
  const holders = (assetId) =>
    db.all(
      `SELECT h.user_id, h.available_tokens + h.locked_tokens AS tokens, u.full_name
         FROM user_holdings h JOIN users u ON u.id = h.user_id
        WHERE h.asset_id = ? AND h.available_tokens + h.locked_tokens > 0
        ORDER BY tokens DESC, h.user_id`,
      assetId,
    );
  const creditBuyer = (userId, assetId, qty, price, { locked }) => {
    const h = holding(userId, assetId);
    const oldQty = h.available_tokens + h.locked_tokens;
    const avg = (h.avg_buy_price * oldQty + price * qty) / (oldQty + qty);
    db.run(
      `UPDATE user_holdings SET ${locked ? "locked_tokens = locked_tokens + ?" : "available_tokens = available_tokens + ?"},
              avg_buy_price = ? WHERE id = ?`,
      qty,
      avg,
      h.id,
    );
  };
  const newBatch = (assetId, kind, lines, actorId) => {
    const id = randomUUID();
    const total = lines.reduce((s, l) => s + l, 0n);
    db.run(
      "INSERT INTO payout_batches (id, asset_id, kind, total_amount, line_count, created_by) VALUES (?,?,?,?,?,?)",
      id,
      assetId,
      kind,
      total,
      BigInt(lines.length),
      actorId,
    );
    return id;
  };
  const payoutTx = (o) => {
    const id = randomUUID();
    db.run(
      `INSERT INTO transactions (id, reference_code, user_id, asset_id, type, token_amount, fiat_amount,
         fee_amount, tax_amount, net_amount, batch_id, status, note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,'AWAITING_PAYOUT',?)`,
      id,
      refCode("PO"),
      o.userId,
      o.assetId,
      o.type,
      o.tokens ?? 0n,
      o.gross,
      o.fee ?? 0n,
      o.tax ?? 0n,
      o.net,
      o.batchId,
      o.note ?? null,
    );
    return id;
  };
  const hasActiveVote = (userId, assetId) =>
    !!db.get(
      `SELECT 1 FROM proposal_votes v JOIN governance_proposals p ON p.id = v.proposal_id
        WHERE v.user_id = ? AND p.asset_id = ? AND p.status = 'VOTING'`,
      userId,
      assetId,
    );
  const ex = createExchange(db, config, {
    requireKyc,
    toBig,
    getAsset,
    holding,
    hasActiveVote,
    creditBuyer,
    newBatch,
    payoutTx,
    paymentInstructions: (t) => paymentInstructions(t),
  });

  // ---------- người dùng & eKYC ----------
  function registerUser(input) {
    const email = str(input.email, "email", { max: 200 }).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "Email không hợp lệ");
    const password = String(input.password || "");
    if (password.length < 8) throw new HttpError(400, "Mật khẩu tối thiểu 8 ký tự");
    // Không cho tự đăng ký ADMIN
    const role = input.role === "OWNER" ? "OWNER" : "INVESTOR";
    return db.tx(() => {
      if (db.get("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "Email đã được sử dụng");
      const id = randomUUID();
      db.run(
        "INSERT INTO users (id, full_name, email, phone, password_hash, role) VALUES (?,?,?,?,?,?)",
        id,
        str(input.full_name, "họ tên", { max: 120 }),
        email,
        str(input.phone, "số điện thoại", { max: 20, required: false }),
        hashPassword(password),
        role,
      );
      db.audit(id, "USER_REGISTERED", "users", id, { email, role });
      return getUser(id);
    });
  }

  function login(email, password) {
    const u = db.get("SELECT * FROM users WHERE email = ?", String(email || "").toLowerCase());
    // So sánh mật khẩu kể cả khi không có user để tránh lộ thông tin qua thời gian phản hồi
    const ok = verifyPassword(String(password || ""), u ? u.password_hash : "scrypt$AAAA$AAAA") && !!u;
    if (!ok) throw new HttpError(401, "Sai email hoặc mật khẩu");
    return u;
  }

  function submitKyc(userId, input) {
    const cccd = str(input.cccd_number, "số CCCD", { max: 12 });
    if (!/^\d{12}$/.test(cccd)) throw new HttpError(400, "Số CCCD phải gồm 12 chữ số");
    return db.tx(() => {
      const u = getUser(userId);
      if (u.kyc_status === "VERIFIED") throw new HttpError(409, "Tài khoản đã được xác thực");
      db.run(
        `UPDATE users SET cccd_number = ?, bank_account_number = ?, bank_name = ?, phone = COALESCE(?, phone),
                kyc_status = 'PENDING' WHERE id = ?`,
        cccd,
        str(input.bank_account_number, "số tài khoản", { max: 30 }),
        str(input.bank_name, "tên ngân hàng", { max: 100 }),
        str(input.phone, "số điện thoại", { max: 20, required: false }) || null,
        userId,
      );
      db.audit(userId, "KYC_SUBMITTED", "users", userId, {});
    });
  }

  function reviewKyc(adminId, userId, approve) {
    return db.tx(() => {
      const u = getUser(userId);
      if (u.kyc_status !== "PENDING") throw new HttpError(409, "Hồ sơ không ở trạng thái chờ duyệt");
      const status = approve ? "VERIFIED" : "REJECTED";
      db.run("UPDATE users SET kyc_status = ? WHERE id = ?", status, userId);
      db.audit(adminId, "KYC_REVIEWED", "users", userId, { status });
      db.notify(userId, "Kết quả eKYC", approve ? "Tài khoản đã được xác thực." : "Hồ sơ eKYC bị từ chối.");
    });
  }

  // ---------- SPV & niêm yết tài sản ----------
  function createSpv(adminId, input) {
    return db.tx(() => {
      const id = randomUUID();
      db.run(
        "INSERT INTO spv_entities (id, company_name, tax_code, bank_custodian_name, custody_certificate_url) VALUES (?,?,?,?,?)",
        id,
        str(input.company_name, "tên công ty", { max: 200 }),
        str(input.tax_code, "mã số thuế", { max: 20 }),
        str(input.bank_custodian_name, "ngân hàng lưu ký", { max: 200 }),
        safeUrl(input.custody_certificate_url, "URL chứng thư lưu ký"),
      );
      db.audit(adminId, "SPV_CREATED", "spv_entities", id, { company_name: input.company_name });
      return id;
    });
  }

  function submitAsset(ownerId, input) {
    requireKyc(ownerId);
    const type = input.asset_type;
    if (!isAssetType(type)) throw new HttpError(400, "Loại tài sản không hợp lệ");
    const def = ASSET_TYPES[type];
    const metadata = {};
    for (const f of def.fields) {
      const v = input.metadata?.[f.key];
      if (v !== undefined && v !== "") metadata[f.key] = str(v, f.label, { max: 500 });
    }
    const valuation = toBig(input.valuation_amount, "giá trị định giá", { min: 1_000_000n });
    const price = toBig(input.token_price ?? 10000, "giá token", { min: 1000n });
    if (valuation % price !== 0n) throw new HttpError(400, "Giá trị định giá phải chia hết cho giá token");
    const total = valuation / price;
    const softCapBps = toBig(input.soft_cap_bps ?? 5000, "ngưỡng gọi vốn tối thiểu", { min: 100n, max: 10000n });
    const monthly = toBig(input.monthly_rent_commitment ?? 0, "thu nhập cam kết hàng tháng", { min: 0n });
    const docs = Array.isArray(input.documents) ? input.documents.slice(0, 20) : [];

    return db.tx(() => {
      const seq = db.get("SELECT COUNT(*) AS n FROM assets WHERE asset_type = ?", type).n + 1n;
      const code = `VN-${def.prefix}-${String(seq).padStart(4, "0")}`;
      const id = randomUUID();
      db.run(
        `INSERT INTO assets (id, asset_code, asset_type, owner_id, title, description, location, image_url,
           metadata_json, tags_json, valuation_amount, token_price, total_tokens, min_funding_tokens,
           is_sale_leaseback, monthly_rent_commitment)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        code,
        type,
        ownerId,
        str(input.title, "tên tài sản", { max: 200 }),
        str(input.description, "mô tả", { max: 5000, required: false }),
        str(input.location, "vị trí", { max: 300, required: false }),
        safeUrl(input.image_url, "URL ảnh"),
        JSON.stringify(metadata),
        JSON.stringify((Array.isArray(input.tags) ? input.tags : []).slice(0, 5).map((t) => str(t, "nhãn", { max: 40 }))),
        valuation,
        price,
        total,
        (total * softCapBps + BPS - 1n) / BPS,
        !!input.is_sale_leaseback,
        monthly,
      );
      for (const d of docs) {
        db.run(
          "INSERT INTO asset_documents (id, asset_id, doc_type, title, url, sha256) VALUES (?,?,?,?,?,?)",
          randomUUID(),
          id,
          str(d.doc_type || "OTHER", "loại hồ sơ", { max: 50 }),
          str(d.title, "tên hồ sơ", { max: 200 }),
          safeUrl(d.url, "URL hồ sơ"),
          d.sha256 && /^[0-9a-f]{64}$/i.test(d.sha256) ? d.sha256.toLowerCase() : null,
        );
      }
      db.audit(ownerId, "ASSET_SUBMITTED", "assets", id, { code, type, valuation });
      return getAsset(id);
    });
  }

  // Admin thẩm định xong → mở gọi vốn. Chủ tài sản nhận 100% token (góp vốn bằng tài sản vào SPV),
  // sau đó bán dần cho nhà đầu tư qua kênh sơ cấp.
  function approveAsset(adminId, assetId, input = {}) {
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "PENDING_REVIEW") throw new HttpError(409, "Tài sản không ở trạng thái chờ thẩm định");
      const spvId = str(input.spv_id, "SPV");
      if (!db.get("SELECT 1 FROM spv_entities WHERE id = ? AND status = 'ACTIVE'", spvId)) {
        throw new HttpError(400, "SPV không tồn tại");
      }
      db.run("UPDATE assets SET status = 'FUNDING', spv_id = ? WHERE id = ?", spvId, assetId);
      const h = holding(a.owner_id, assetId);
      db.run(
        "UPDATE user_holdings SET available_tokens = ?, avg_buy_price = ? WHERE id = ?",
        a.total_tokens,
        a.token_price,
        h.id,
      );
      db.run("INSERT INTO price_history (asset_id, price) VALUES (?,?)", assetId, a.token_price);
      db.audit(adminId, "ASSET_APPROVED", "assets", assetId, { spvId, total_tokens: a.total_tokens });
      db.notify(a.owner_id, "Tài sản đã được niêm yết", `${a.asset_code} đã mở gọi vốn.`);
    });
  }

  function rejectAsset(adminId, assetId, reason) {
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "PENDING_REVIEW") throw new HttpError(409, "Tài sản không ở trạng thái chờ thẩm định");
      db.run("UPDATE assets SET status = 'DRAFT' WHERE id = ?", assetId);
      db.audit(adminId, "ASSET_REJECTED", "assets", assetId, { reason });
      db.notify(a.owner_id, "Hồ sơ cần bổ sung", `${a.asset_code}: ${str(reason, "lý do", { required: false })}`);
    });
  }

  // ---------- Đặt mua sơ cấp (VietQR / Virtual Account) ----------
  function vietQr(amount, ref) {
    const { bankId, accountNo, accountName } = config.escrow;
    const q = new URLSearchParams({ amount: amount.toString(), addInfo: ref, accountName });
    return `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-compact2.png?${q}`;
  }

  function paymentInstructions(tx) {
    return {
      transaction_id: tx.id,
      reference_code: tx.reference_code,
      amount: tx.fiat_amount,
      bank_id: config.escrow.bankId,
      account_no: config.escrow.accountNo,
      account_name: config.escrow.accountName,
      qr_url: vietQr(tx.fiat_amount, tx.reference_code),
      expires_at: tx.expires_at,
    };
  }

  // Ghi nhận giao dịch mua sơ cấp đã thanh toán (gọi bên trong tx)
  function completePrimary(t) {
    const a = getAsset(t.asset_id);
    db.run("UPDATE assets SET reserved_tokens = reserved_tokens - ?, sold_tokens = sold_tokens + ? WHERE id = ?", t.token_amount, t.token_amount, a.id);
    db.run("UPDATE user_holdings SET available_tokens = available_tokens - ? WHERE user_id = ? AND asset_id = ?", t.token_amount, a.owner_id, a.id);
    // Token bị khóa cho tới khi đạt Soft Cap & tài sản sang tên SPV (Admin kích hoạt)
    creditBuyer(t.user_id, a.id, t.token_amount, a.token_price, { locked: true });
    db.notify(t.user_id, "Đã nhận thanh toán", `${t.token_amount} token ${a.asset_code} đang chờ hoàn tất gọi vốn.`);
  }

  function createPrimaryOrder(userId, assetId, tokenAmount, { fromWallet = false } = {}) {
    requireKyc(userId);
    const qty = toBig(tokenAmount, "số lượng token");
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "FUNDING") throw new HttpError(409, "Tài sản không trong giai đoạn gọi vốn");
      if (a.owner_id === userId) throw new HttpError(400, "Chủ tài sản không thể tự mua suất sơ cấp");
      const remaining = a.total_tokens - a.sold_tokens - a.reserved_tokens;
      if (qty > remaining) throw new HttpError(409, `Chỉ còn ${remaining} token khả dụng`);
      db.run("UPDATE assets SET reserved_tokens = reserved_tokens + ? WHERE id = ?", qty, assetId);
      const id = randomUUID();
      const fiat = qty * a.token_price;
      db.run(
        `INSERT INTO transactions (id, reference_code, user_id, asset_id, type, token_amount, fiat_amount, net_amount, expires_at)
         VALUES (?,?,?,?,'BUY_PRIMARY',?,?,?, datetime('now', ?))`,
        id,
        refCode(a.asset_code.replaceAll("-", "").slice(2)),
        userId,
        assetId,
        qty,
        fiat,
        fiat,
        `+${config.orderTtlMinutes} minutes`,
      );
      db.audit(userId, "ORDER_CREATED", "transactions", id, { type: "BUY_PRIMARY", qty, fiat, fromWallet });
      if (fromWallet) {
        // Thanh toán ngay bằng số dư ví (tiền đã nằm trong tài khoản phong tỏa)
        ex.debitCash(userId, fiat);
        const t = db.get("SELECT * FROM transactions WHERE id = ?", id);
        completePrimary(t);
        db.run("UPDATE transactions SET status = 'COMPLETED', bank_txn_id = 'WALLET', completed_at = datetime('now') WHERE id = ?", id);
        return { transaction_id: id, reference_code: t.reference_code, amount: fiat, paid_from_wallet: true };
      }
      return paymentInstructions(db.get("SELECT * FROM transactions WHERE id = ?", id));
    });
  }

  // Giải phóng phần giữ chỗ của 1 đơn chưa thanh toán (gọi bên trong tx)
  function releaseOrder(tx, newStatus) {
    if (tx.type === "BUY_PRIMARY") {
      db.run("UPDATE assets SET reserved_tokens = reserved_tokens - ? WHERE id = ?", tx.token_amount, tx.asset_id);
    }
    db.run("UPDATE transactions SET status = ? WHERE id = ?", newStatus, tx.id);
  }

  function cancelOrder(userId, txId) {
    return db.tx(() => {
      const t = db.get("SELECT * FROM transactions WHERE id = ?", txId);
      if (!t || t.user_id !== userId) throw new HttpError(404, "Không tìm thấy đơn");
      if (t.status !== "PENDING") throw new HttpError(409, "Đơn không thể hủy");
      releaseOrder(t, "CANCELLED");
      db.audit(userId, "ORDER_CANCELLED", "transactions", txId, {});
    });
  }

  function expireStaleOrders() {
    return db.tx(() => {
      const stale = db.all(
        "SELECT * FROM transactions WHERE status = 'PENDING' AND expires_at IS NOT NULL AND expires_at < datetime('now')",
      );
      for (const t of stale) {
        releaseOrder(t, "EXPIRED");
        db.audit(null, "ORDER_EXPIRED", "transactions", t.id, {});
      }
      return stale.length;
    });
  }

  // ---------- Webhook ngân hàng (đã xác thực HMAC ở tầng HTTP) ----------
  function handleBankPayment(payload) {
    const ref = str(payload.reference_code, "reference_code", { max: 40 });
    const amount = toBig(payload.amount, "amount");
    const bankTxnId = str(payload.bank_txn_id, "bank_txn_id", { max: 80, required: false }) || null;
    return db.tx(() => {
      const t = db.get("SELECT * FROM transactions WHERE reference_code = ?", ref);
      if (!t) {
        db.audit(null, "PAYMENT_UNMATCHED", "transactions", null, { ref, amount, bankTxnId });
        return { ok: false, status: 404, result: "UNMATCHED" };
      }
      // Lũy đẳng: ngân hàng gửi lại webhook nhiều lần không được cộng trùng token
      if (t.status === "COMPLETED") return { ok: true, status: 200, result: "DUPLICATE_IGNORED" };
      // Nạp tiền: luôn ghi có đúng số tiền thực nhận vào ví (kể cả khi yêu cầu nạp đã hết hạn)
      if (t.type === "DEPOSIT") {
        ex.creditCash(t.user_id, amount);
        db.run(
          "UPDATE transactions SET status = 'COMPLETED', fiat_amount = ?, net_amount = ?, bank_txn_id = ?, completed_at = datetime('now') WHERE id = ?",
          amount,
          amount,
          bankTxnId,
          t.id,
        );
        db.notify(t.user_id, "Nạp tiền thành công", `Đã cộng ${amount} VND vào ví.`);
        db.audit(null, "DEPOSIT_CONFIRMED", "transactions", t.id, { ref, amount, bankTxnId });
        return { ok: true, status: 200, result: "COMPLETED" };
      }
      if (t.status !== "PENDING") {
        // Tiền về muộn cho đơn đã hết hạn/hủy → lập lệnh hoàn tiền chờ Admin duyệt
        const batchId = newBatch(t.asset_id, "REFUND", [amount], null);
        payoutTx({ userId: t.user_id, assetId: t.asset_id, type: "REFUND", gross: amount, net: amount, batchId, note: `Hoàn tiền về muộn cho ${ref}` });
        db.run("UPDATE transactions SET bank_txn_id = ?, note = 'LATE_PAYMENT_REFUNDED' WHERE id = ?", bankTxnId, t.id);
        db.audit(null, "LATE_PAYMENT_REFUND", "transactions", t.id, { amount, bankTxnId });
        return { ok: true, status: 200, result: "LATE_PAYMENT_REFUND_QUEUED" };
      }
      if (amount !== t.fiat_amount) {
        db.audit(null, "PAYMENT_AMOUNT_MISMATCH", "transactions", t.id, { expected: t.fiat_amount, amount, bankTxnId });
        return { ok: false, status: 409, result: "AMOUNT_MISMATCH_MANUAL_REVIEW" };
      }

      if (t.type === "BUY_PRIMARY") {
        completePrimary(t);
      }
      db.run(
        "UPDATE transactions SET status = 'COMPLETED', bank_txn_id = ?, completed_at = datetime('now') WHERE id = ?",
        bankTxnId,
        t.id,
      );
      db.audit(null, "PAYMENT_CONFIRMED", "transactions", t.id, { ref, amount, bankTxnId, type: t.type });
      return { ok: true, status: 200, result: "COMPLETED" };
    });
  }

  // ---------- Kết thúc gọi vốn ----------
  function activateAsset(adminId, assetId) {
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "FUNDING") throw new HttpError(409, "Tài sản không trong giai đoạn gọi vốn");
      if (a.sold_tokens < a.min_funding_tokens) throw new HttpError(409, "Chưa đạt ngưỡng gọi vốn tối thiểu (Soft Cap)");
      for (const t of db.all("SELECT * FROM transactions WHERE asset_id = ? AND status = 'PENDING' AND type = 'BUY_PRIMARY'", assetId)) {
        releaseOrder(t, "CANCELLED");
      }
      // Mở khóa toàn bộ token chờ (trong FUNDING, locked chỉ có ý nghĩa "chờ gọi vốn")
      db.run("UPDATE user_holdings SET available_tokens = available_tokens + locked_tokens, locked_tokens = 0 WHERE asset_id = ?", assetId);
      const raised = a.sold_tokens * a.token_price;
      // Bán & thuê lại: giữ lại quỹ dự phòng 6 tháng tiền thuê trong tài khoản phong tỏa
      const reserve = a.is_sale_leaseback ? minBig(a.monthly_rent_commitment * 6n, raised) : 0n;
      db.run(
        "UPDATE assets SET status = 'ACTIVE', rent_escrow_balance = rent_escrow_balance + ?, activated_at = datetime('now') WHERE id = ?",
        reserve,
        assetId,
      );
      const disbursement = raised - reserve;
      let batchId = null;
      if (disbursement > 0n) {
        batchId = newBatch(assetId, "OWNER_DISBURSEMENT", [disbursement], adminId);
        payoutTx({
          userId: a.owner_id,
          assetId,
          type: "OWNER_DISBURSEMENT",
          tokens: a.sold_tokens,
          gross: raised,
          fee: reserve,
          net: disbursement,
          batchId,
          note: reserve > 0n ? `Đã giữ lại ${reserve} VND quỹ dự phòng thuê 6 tháng` : null,
        });
      }
      db.audit(adminId, "ASSET_ACTIVATED", "assets", assetId, { raised, reserve, batchId });
      for (const h of holders(assetId)) {
        db.notify(h.user_id, "Gọi vốn thành công", `${a.asset_code} đã hoàn tất sang tên SPV và mở giao dịch.`);
      }
      return { raised, reserve, disbursement, batchId };
    });
  }

  function failFunding(adminId, assetId) {
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "FUNDING") throw new HttpError(409, "Tài sản không trong giai đoạn gọi vốn");
      for (const t of db.all("SELECT * FROM transactions WHERE asset_id = ? AND status = 'PENDING' AND type = 'BUY_PRIMARY'", assetId)) {
        releaseOrder(t, "CANCELLED");
      }
      const paid = db.all("SELECT * FROM transactions WHERE asset_id = ? AND status = 'COMPLETED' AND type = 'BUY_PRIMARY'", assetId);
      const bankPaid = paid.filter((t) => t.bank_txn_id !== "WALLET");
      const batchId = bankPaid.length ? newBatch(assetId, "REFUND", bankPaid.map((t) => t.fiat_amount), adminId) : null;
      for (const t of paid) {
        db.run(
          "UPDATE user_holdings SET locked_tokens = locked_tokens - ? WHERE user_id = ? AND asset_id = ?",
          t.token_amount,
          t.user_id,
          assetId,
        );
        db.run("UPDATE transactions SET status = 'REFUNDED' WHERE id = ?", t.id);
        if (t.bank_txn_id === "WALLET") ex.creditCash(t.user_id, t.fiat_amount);
        else payoutTx({ userId: t.user_id, assetId, type: "REFUND", tokens: t.token_amount, gross: t.fiat_amount, net: t.fiat_amount, batchId, note: `Hoàn tiền ${t.reference_code}` });
        db.notify(t.user_id, "Gọi vốn không thành công", `${a.asset_code} không đạt Soft Cap, tiền sẽ được hoàn 100%.`, "WARNING");
      }
      db.run("UPDATE user_holdings SET available_tokens = ? WHERE user_id = ? AND asset_id = ?", a.total_tokens, a.owner_id, assetId);
      db.run("UPDATE assets SET status = 'FUNDING_FAILED', sold_tokens = 0 WHERE id = ?", assetId);
      db.audit(adminId, "FUNDING_FAILED", "assets", assetId, { refunds: paid.length, batchId });
      return { refunds: paid.length, batchId };
    });
  }

  // ---------- Chia cổ tức thu nhập hàng tháng ----------
  function activeValueAddProposal(assetId) {
    return db.get(
      `SELECT * FROM governance_proposals WHERE asset_id = ? AND proposal_type = 'VALUE_ADD_5_10_PERCENT'
        AND status = 'APPROVED' ORDER BY created_at DESC LIMIT 1`,
      assetId,
    );
  }

  /** Tính phân bổ (thuần, không ghi DB) — dùng cho xem trước và cho test. */
  function previewRentDistribution(assetId, grossRentAmount) {
    const a = getAsset(assetId);
    const gross = toBig(grossRentAmount, "doanh thu kỳ");
    const platformFee = (gross * config.platformFeeBps) / BPS;
    const p = activeValueAddProposal(assetId);
    let operatorReward = 0n;
    if (p && gross > p.base_income) operatorReward = ((gross - p.base_income) * p.reward_bps) / BPS;
    const net = gross - platformFee - operatorReward;
    const total = a.total_tokens;
    const lines = holders(assetId).map((h) => {
      const grossDiv = (h.tokens * net) / total; // làm tròn xuống đơn vị VND
      const tax = (grossDiv * config.dividendTaxBps) / BPS;
      return { user_id: h.user_id, full_name: h.full_name, tokens: h.tokens, gross: grossDiv, tax, net: grossDiv - tax };
    });
    const distributed = lines.reduce((s, l) => s + l.gross, 0n);
    return {
      gross,
      platformFee,
      operatorReward,
      operatorId: operatorReward > 0n ? p.proposer_id : null,
      netDistributableAmount: net,
      dust: net - distributed,
      lines,
    };
  }

  function distributeMonthlyRent(adminId, assetId, grossRentAmount, { period, fromReserve = false } = {}) {
    const per = str(period, "kỳ (YYYY-MM)", { max: 7 });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(per)) throw new HttpError(400, "Kỳ phải có dạng YYYY-MM");
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "ACTIVE" && a.status !== "HALTED_PLANNING") throw new HttpError(409, "Tài sản chưa vận hành");
      if (db.get("SELECT 1 FROM income_reports WHERE asset_id = ? AND period = ?", assetId, per)) {
        throw new HttpError(409, "Kỳ này đã được chia cổ tức");
      }
      const r = previewRentDistribution(assetId, grossRentAmount);
      if (fromReserve) {
        if (a.rent_escrow_balance < r.gross) throw new HttpError(409, "Quỹ dự phòng không đủ");
        db.run("UPDATE assets SET rent_escrow_balance = rent_escrow_balance - ? WHERE id = ?", r.gross, assetId);
      }
      const payLines = r.lines.filter((l) => l.net > 0n);
      const amounts = payLines.map((l) => l.net);
      if (r.operatorReward > 0n) amounts.push(r.operatorReward);
      const batchId = newBatch(assetId, "DIVIDEND", amounts, adminId);
      const taxTotal = r.lines.reduce((s, l) => s + l.tax, 0n);
      for (const l of payLines) {
        payoutTx({ userId: l.user_id, assetId, type: "DIVIDEND", tokens: l.tokens, gross: l.gross, tax: l.tax, net: l.net, batchId, note: `Cổ tức kỳ ${per}` });
        db.notify(l.user_id, "Cổ tức mới", `${a.asset_code} kỳ ${per}: ${l.net} VND (đã trừ thuế TNCN ${l.tax} VND).`);
      }
      if (r.operatorReward > 0n) {
        payoutTx({ userId: r.operatorId, assetId, type: "DIVIDEND", gross: r.operatorReward, net: r.operatorReward, batchId, note: `Thưởng hiệu suất vận hành kỳ ${per}` });
      }
      db.run(
        `INSERT INTO income_reports (id, asset_id, period, gross_amount, platform_fee, operator_reward, tax_total, net_paid, dust, from_reserve, batch_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(),
        assetId,
        per,
        r.gross,
        r.platformFee,
        r.operatorReward,
        taxTotal,
        amounts.reduce((s, x) => s + x, 0n),
        r.dust,
        fromReserve,
        batchId,
      );
      db.audit(adminId, "DIVIDEND_DISTRIBUTED", "assets", assetId, { period: per, gross: r.gross, batchId, fromReserve });
      return { ...r, batchId, taxTotal };
    });
  }

  // ---------- Quản trị & biểu quyết ----------
  function createProposal(userId, assetId, input) {
    const type = input.proposal_type;
    if (!["VALUE_ADD_5_10_PERCENT", "FULL_EXIT_SALE", "BUYBACK_DELISTING"].includes(type)) {
      throw new HttpError(400, "Loại đề xuất không hợp lệ");
    }
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "ACTIVE") throw new HttpError(409, "Chỉ tài sản đang vận hành mới tạo được đề xuất");
      const h = holding(userId, assetId);
      if (h.available_tokens + h.locked_tokens === 0n) throw new HttpError(403, "Chỉ cổ đông mới được đề xuất");
      if (type === "BUYBACK_DELISTING" && userId !== a.owner_id) throw new HttpError(403, "Chỉ chủ cũ mới có quyền chuộc lại");
      let rewardBps = 0n;
      if (type === "VALUE_ADD_5_10_PERCENT") rewardBps = toBig(input.reward_bps, "tỷ lệ thưởng", { min: 500n, max: 1000n });
      const price = type === "VALUE_ADD_5_10_PERCENT" ? 0n : toBig(input.proposed_price, "giá đề xuất");
      const days = Number(input.voting_days ?? 14);
      if (!Number.isInteger(days) || days < 1 || days > 60) throw new HttpError(400, "Thời hạn biểu quyết 1–60 ngày");
      const id = randomUUID();
      db.run(
        `INSERT INTO governance_proposals (id, asset_id, proposer_id, proposal_type, title, description, proposed_price,
           reward_bps, base_income, approval_threshold_bps, deadline) VALUES (?,?,?,?,?,?,?,?,?,7500,?)`,
        id,
        assetId,
        userId,
        type,
        str(input.title, "tiêu đề", { max: 200 }),
        str(input.description, "mô tả", { max: 5000, required: false }),
        price,
        rewardBps,
        a.monthly_rent_commitment,
        sqlTime(Date.now() + days * 86400000),
      );
      db.audit(userId, "PROPOSAL_CREATED", "governance_proposals", id, { type, price, rewardBps });
      for (const x of holders(assetId)) {
        if (x.user_id !== userId) db.notify(x.user_id, "Đề xuất mới cần biểu quyết", `${a.asset_code}: ${input.title}`);
      }
      return id;
    });
  }

  function tally(p, totalTokens) {
    const rows = db.all("SELECT decision, SUM(vote_weight_tokens) AS w FROM proposal_votes WHERE proposal_id = ? GROUP BY decision", p.id);
    const agree = rows.find((r) => r.decision === "AGREE")?.w ?? 0n;
    const disagree = rows.find((r) => r.decision === "DISAGREE")?.w ?? 0n;
    return { agree, disagree, agreeBps: (agree * BPS) / totalTokens, disagreeBps: (disagree * BPS) / totalTokens };
  }

  function castVote(proposalId, userId, decision) {
    if (decision !== "AGREE" && decision !== "DISAGREE") throw new HttpError(400, "Lựa chọn không hợp lệ");
    return db.tx(() => {
      const p = db.get("SELECT * FROM governance_proposals WHERE id = ?", proposalId);
      if (!p) throw new HttpError(404, "Không tìm thấy đề xuất");
      if (p.status !== "VOTING") throw new HttpError(409, "Đề xuất đã kết thúc biểu quyết");
      if (db.get("SELECT 1 FROM governance_proposals WHERE id = ? AND deadline < datetime('now')", proposalId)) {
        throw new HttpError(409, "Đã hết hạn biểu quyết");
      }
      const a = getAsset(p.asset_id);
      const h = holding(userId, p.asset_id);
      const weight = h.available_tokens + h.locked_tokens;
      if (weight === 0n) throw new HttpError(403, "Bạn không sở hữu token của tài sản này");
      if (db.get("SELECT 1 FROM proposal_votes WHERE proposal_id = ? AND user_id = ?", proposalId, userId)) {
        throw new HttpError(409, "Bạn đã biểu quyết");
      }
      db.run(
        "INSERT INTO proposal_votes (id, proposal_id, user_id, vote_weight_tokens, decision) VALUES (?,?,?,?,?)",
        randomUUID(),
        proposalId,
        userId,
        weight,
        decision,
      );
      const t = tally(p, a.total_tokens);
      let status = "VOTING";
      // Thông qua khi tỷ lệ đồng ý VƯỢT ngưỡng (vd > 75%) trên TỔNG số token phát hành
      if (t.agree * BPS > a.total_tokens * p.approval_threshold_bps) status = "APPROVED";
      // Bác bỏ sớm khi phần phản đối khiến đề xuất không thể vượt ngưỡng
      else if (t.disagree * BPS >= a.total_tokens * (BPS - p.approval_threshold_bps)) status = "REJECTED";
      if (status !== "VOTING") db.run("UPDATE governance_proposals SET status = ? WHERE id = ?", status, proposalId);
      db.audit(userId, "VOTE_CAST", "governance_proposals", proposalId, { decision, weight, status });
      return { ...t, status };
    });
  }

  function closeExpiredProposals() {
    return db.tx(() => {
      const n = db.run("UPDATE governance_proposals SET status = 'REJECTED' WHERE status = 'VOTING' AND deadline < datetime('now')").changes;
      if (n) db.audit(null, "PROPOSALS_EXPIRED", "governance_proposals", null, { count: n });
      return Number(n);
    });
  }

  // ---------- Ma trận thoái vốn ----------
  function proRata(list, amount, total) {
    const lines = list.map((h) => ({ user_id: h.user_id, full_name: h.full_name, tokens: h.tokens, amount: (h.tokens * amount) / total }));
    const dust = amount - lines.reduce((s, l) => s + l.amount, 0n);
    if (lines.length && dust > 0n) lines[0].amount += dust; // phần lẻ cho cổ đông lớn nhất
    return lines;
  }

  function calculateExitPayout(assetId, finalSalePrice, { proposalId } = {}) {
    const a = getAsset(assetId);
    const price = toBig(finalSalePrice, "giá bán cuối cùng");
    const list = holders(assetId);
    const total = a.total_tokens;
    const owner = list.find((h) => h.user_id === a.owner_id);
    const ownerTokens = owner?.tokens ?? 0n;
    const dragAlong = ownerTokens * BPS > total * 9000n;

    if (dragAlong) {
      if (price >= a.valuation_amount) {
        return { mode: "DRAG_ALONG_PROFIT", price, lines: proRata(list, price, total) };
      }
      // Bán lỗ: cổ đông nhỏ lẻ được ưu tiên nhận đủ mệnh giá gốc, chủ cũ gánh phần lỗ
      const minorities = list.filter((h) => h.user_id !== a.owner_id);
      const faceTotal = minorities.reduce((s, h) => s + h.tokens * a.token_price, 0n);
      if (faceTotal >= price) {
        const minorTokens = minorities.reduce((s, h) => s + h.tokens, 0n);
        const lines = proRata(minorities, price, minorTokens);
        if (owner) lines.push({ user_id: owner.user_id, full_name: owner.full_name, tokens: ownerTokens, amount: 0n });
        return { mode: "DRAG_ALONG_LOSS", price, lines };
      }
      const lines = minorities.map((h) => ({ user_id: h.user_id, full_name: h.full_name, tokens: h.tokens, amount: h.tokens * a.token_price }));
      lines.unshift({ user_id: owner.user_id, full_name: owner.full_name, tokens: ownerTokens, amount: price - faceTotal });
      return { mode: "DRAG_ALONG_LOSS", price, lines };
    }

    // Cổ đông phân tán: bắt buộc có đề xuất FULL_EXIT_SALE đã được > 75% thông qua
    const p = proposalId
      ? db.get("SELECT * FROM governance_proposals WHERE id = ? AND asset_id = ?", proposalId, assetId)
      : db.get("SELECT * FROM governance_proposals WHERE asset_id = ? AND proposal_type = 'FULL_EXIT_SALE' AND status = 'APPROVED' ORDER BY created_at DESC LIMIT 1", assetId);
    if (!p || p.proposal_type !== "FULL_EXIT_SALE" || p.status !== "APPROVED") {
      throw new HttpError(409, "Cần đề xuất Bán toàn bộ (FULL_EXIT_SALE) đã được thông qua > 75%", "VOTE_REQUIRED");
    }
    return { mode: "VOTED_PRO_RATA", price, proposalId: p.id, lines: proRata(list, price, total) };
  }

  function settleExit(adminId, a, kind, txType, lines, extra) {
    const pay = lines.filter((l) => l.amount > 0n);
    const batchId = newBatch(a.id, kind, pay.map((l) => l.amount), adminId);
    for (const l of pay) {
      payoutTx({ userId: l.user_id, assetId: a.id, type: txType, tokens: l.tokens, gross: l.amount, net: l.amount, batchId, note: extra.note });
    }
    ex.cancelAllForAsset(a.id, "DELISTED");
    for (const t of db.all("SELECT * FROM transactions WHERE asset_id = ? AND status = 'PENDING'", a.id)) {
      db.run("UPDATE transactions SET status = 'CANCELLED' WHERE id = ?", t.id);
    }
    db.run("UPDATE assets SET status = 'DELISTED', reserved_tokens = 0 WHERE id = ?", a.id);
    for (const l of lines) {
      db.notify(l.user_id, "Tất toán tài sản", `${a.asset_code} đã hủy niêm yết. Khoản nhận: ${l.amount} VND.`, "WARNING");
    }
    return batchId;
  }

  function executeExit(adminId, assetId, finalSalePrice, opts = {}) {
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "ACTIVE" && a.status !== "HALTED_PLANNING") throw new HttpError(409, "Tài sản không thể tất toán");
      const calc = calculateExitPayout(assetId, finalSalePrice, opts);
      const batchId = settleExit(adminId, a, "EXIT", "EXIT_PAYOUT", calc.lines, { note: `Tất toán (${calc.mode})` });
      db.run("UPDATE user_holdings SET available_tokens = 0, locked_tokens = 0 WHERE asset_id = ?", assetId);
      if (calc.proposalId) db.run("UPDATE governance_proposals SET status = 'EXECUTED', executed_at = datetime('now') WHERE id = ?", calc.proposalId);
      db.audit(adminId, "ASSET_EXITED", "assets", assetId, { mode: calc.mode, price: calc.price, batchId });
      return { ...calc, batchId };
    });
  }

  // Chủ cũ thực hiện quyền chuộc lại (Call Option): mua lại toàn bộ token của cổ đông khác
  function executeBuyback(adminId, proposalId) {
    return db.tx(() => {
      const p = db.get("SELECT * FROM governance_proposals WHERE id = ?", proposalId);
      if (!p || p.proposal_type !== "BUYBACK_DELISTING" || p.status !== "APPROVED") {
        throw new HttpError(409, "Đề xuất chuộc lại chưa được thông qua");
      }
      const a = getAsset(p.asset_id);
      const lines = holders(a.id)
        .filter((h) => h.user_id !== a.owner_id)
        .map((h) => ({ ...h, amount: h.tokens * p.proposed_price }));
      const batchId = settleExit(adminId, a, "BUYBACK", "EXIT_PAYOUT", lines, { note: "Chủ cũ chuộc lại tài sản" });
      db.run("UPDATE user_holdings SET available_tokens = 0, locked_tokens = 0 WHERE asset_id = ? AND user_id <> ?", a.id, a.owner_id);
      db.run("UPDATE user_holdings SET available_tokens = ?, locked_tokens = 0 WHERE asset_id = ? AND user_id = ?", a.total_tokens, a.id, a.owner_id);
      db.run("UPDATE governance_proposals SET status = 'EXECUTED', executed_at = datetime('now') WHERE id = ?", proposalId);
      db.audit(adminId, "ASSET_BUYBACK", "assets", a.id, { proposalId, price: p.proposed_price, batchId });
      return { batchId, lines };
    });
  }

  // ---------- Tạm ngừng giao dịch khẩn cấp ----------
  function triggerPlanningHalt(adminId, assetId, officialNoticeUrl) {
    const url = safeUrl(officialNoticeUrl, "URL văn bản thông báo");
    if (!url) throw new HttpError(400, "Cần đường dẫn văn bản thông báo chính thức");
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "ACTIVE" && a.status !== "FUNDING") throw new HttpError(409, "Tài sản không ở trạng thái giao dịch");
      // 1) Hủy toàn bộ lệnh trên sổ lệnh (hoàn tiền/token phong tỏa)
      ex.cancelAllForAsset(assetId, "HALT");
      // 2) Hủy mọi đơn mua sơ cấp chờ thanh toán
      for (const t of db.all("SELECT * FROM transactions WHERE asset_id = ? AND status = 'PENDING'", assetId)) {
        releaseOrder(t, "CANCELLED");
      }
      db.run("UPDATE assets SET status = 'HALTED_PLANNING', halt_notice_url = ? WHERE id = ?", url, assetId);
      const label = ASSET_TYPES[a.asset_type]?.haltLabel ?? "Sự kiện pháp lý";
      for (const h of holders(assetId)) {
        db.notify(h.user_id, `KHẨN: Tạm ngừng giao dịch ${a.asset_code}`, `${label}. Mọi giao dịch thứ cấp đã bị khóa. Xem văn bản: ${url}`, "CRITICAL");
      }
      db.audit(adminId, "TRADING_HALTED", "assets", assetId, { url });
    });
  }

  function resumeTrading(adminId, assetId) {
    return db.tx(() => {
      const a = getAsset(assetId);
      if (a.status !== "HALTED_PLANNING") throw new HttpError(409, "Tài sản không bị tạm ngừng");
      const next = a.activated_at ? "ACTIVE" : "FUNDING";
      db.run("UPDATE assets SET status = ? WHERE id = ?", next, assetId);
      for (const h of holders(assetId)) db.notify(h.user_id, "Mở lại giao dịch", `${a.asset_code} đã được mở lại giao dịch.`);
      db.audit(adminId, "TRADING_RESUMED", "assets", assetId, { next });
    });
  }

  // ---------- Bảng kê chi (Payout Batch) ----------
  function markBatchPaid(adminId, batchId) {
    return db.tx(() => {
      const b = db.get("SELECT * FROM payout_batches WHERE id = ?", batchId);
      if (!b) throw new HttpError(404, "Không tìm thấy bảng kê");
      if (b.status === "PAID") throw new HttpError(409, "Bảng kê đã được xác nhận chi");
      db.run("UPDATE payout_batches SET status = 'PAID', paid_at = datetime('now') WHERE id = ?", batchId);
      db.run("UPDATE transactions SET status = 'COMPLETED', completed_at = datetime('now') WHERE batch_id = ? AND status = 'AWAITING_PAYOUT'", batchId);
      db.audit(adminId, "BATCH_PAID", "payout_batches", batchId, { total: b.total_amount });
    });
  }

  function batchCsv(batchId) {
    const rows = db.all(
      `SELECT t.reference_code, t.net_amount, t.type, t.note, u.full_name, u.bank_account_number, u.bank_name
         FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.batch_id = ? ORDER BY u.full_name`,
      batchId,
    );
    // Chống CSV/Formula injection khi mở bằng Excel
    const cell = (v) => {
      let s = v === null || v === undefined ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replaceAll('"', '""')}"`;
    };
    const head = ["STT", "Ho ten", "So tai khoan", "Ngan hang", "So tien (VND)", "Noi dung", "Ma tham chieu"];
    const lines = rows.map((r, i) =>
      [i + 1, r.full_name, r.bank_account_number, r.bank_name, r.net_amount, `${r.type} ${r.note ?? ""}`.trim(), r.reference_code].map(cell).join(","),
    );
    return `﻿${[head.map(cell).join(","), ...lines].join("\r\n")}\r\n`;
  }

  // Bất biến sổ cái: tổng token của mọi cổ đông = tổng token phát hành
  function checkInvariants(assetId) {
    const a = getAsset(assetId);
    if (a.status === "PENDING_REVIEW" || a.status === "DRAFT" || a.status === "DELISTED") return { ok: true };
    const sum = db.get("SELECT COALESCE(SUM(available_tokens + locked_tokens), 0) AS s FROM user_holdings WHERE asset_id = ?", assetId).s;
    return { ok: sum === a.total_tokens, sum, total: a.total_tokens };
  }

  return {
    registerUser,
    login,
    submitKyc,
    reviewKyc,
    createSpv,
    submitAsset,
    approveAsset,
    rejectAsset,
    paymentInstructions,
    createPrimaryOrder,
    cancelOrder,
    expireStaleOrders,
    handleBankPayment,
    activateAsset,
    failFunding,
    previewRentDistribution,
    distributeMonthlyRent,
    createProposal,
    castVote,
    tally,
    closeExpiredProposals,
    calculateExitPayout,
    executeExit,
    executeBuyback,
    triggerPlanningHalt,
    resumeTrading,
    markBatchPaid,
    batchCsv,
    checkInvariants,
    holders,
    exchange: ex,
  };
}
