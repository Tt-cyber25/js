import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { hmacHex } from "../src/auth.js";
import { openDb } from "../src/db.js";
import { createLedger } from "../src/ledger.js";
import { createApp } from "../src/server.js";

const config = {
  isProd: false,
  jwtSecret: "test-jwt-secret-test-jwt-secret-1234",
  webhookSecret: "test-webhook-secret-test-webhook-1234",
  escrow: { bankId: "970422", accountNo: "123", accountName: "SPV TEST" },
  platformFeeBps: 500n,
  tradeFeeBps: 15n,
  sellTaxBps: 10n,
  bandBps: 1000n,
  tickSize: 10n,
  dividendTaxBps: 500n,
  orderTtlMinutes: 30,
  allowBankSimulator: true,
};

function setup() {
  const db = openDb(":memory:");
  const L = createLedger(db, config);
  const user = (name, role = "INVESTOR") => {
    const u = L.registerUser({ full_name: name, email: `${name}@t.vn`, password: "Password1!", role });
    L.submitKyc(u.id, { cccd_number: "001090000001", bank_account_number: "111", bank_name: "VCB" });
    return u.id;
  };
  const adminId = user("admin");
  db.run("UPDATE users SET role = 'ADMIN' WHERE id = ?", adminId);
  const kyc = (id) => L.reviewKyc(adminId, id, true);
  kyc(adminId);
  const spv = L.createSpv(adminId, { company_name: "SPV", tax_code: "0101", bank_custodian_name: "Bank" });
  const newAsset = (ownerId, extra = {}) => {
    const a = L.submitAsset(ownerId, {
      asset_type: "PATENT",
      title: "Test",
      valuation_amount: 1_000_000_000, // 100.000 token x 10.000đ
      soft_cap_bps: 1000,
      monthly_rent_commitment: 10_000_000,
      ...extra,
    });
    L.approveAsset(adminId, a.id, { spv_id: spv });
    return a.id;
  };
  const pay = (instr) => L.handleBankPayment({ reference_code: instr.reference_code, amount: instr.amount, bank_txn_id: "B1" });
  const hold = (u, a) => db.get("SELECT * FROM user_holdings WHERE user_id = ? AND asset_id = ?", u, a);
  return { db, L, user, kyc, adminId, newAsset, pay, hold };
}

function scenario(assetOpts) {
  const s = setup();
  const owner = s.user("owner", "OWNER");
  const i1 = s.user("i1");
  const i2 = s.user("i2");
  for (const id of [owner, i1, i2]) s.kyc(id);
  const asset = s.newAsset(owner, assetOpts);
  return { ...s, owner, i1, i2, asset };
}

describe("Mua sơ cấp & webhook ngân hàng", () => {
  it("cộng token khóa, lũy đẳng khi webhook gửi lại, từ chối sai số tiền", () => {
    const { L, i1, asset, hold, owner } = scenario();
    const o = L.createPrimaryOrder(i1, asset, 1000);
    assert.equal(o.amount, 10_000_000n);
    assert.match(o.qr_url, /^https:\/\/img\.vietqr\.io\//);

    const bad = L.handleBankPayment({ reference_code: o.reference_code, amount: 9_999_999 });
    assert.equal(bad.result, "AMOUNT_MISMATCH_MANUAL_REVIEW");
    assert.equal(hold(i1, asset)?.locked_tokens ?? 0n, 0n);

    assert.equal(L.handleBankPayment({ reference_code: o.reference_code, amount: 10_000_000 }).result, "COMPLETED");
    assert.equal(L.handleBankPayment({ reference_code: o.reference_code, amount: 10_000_000 }).result, "DUPLICATE_IGNORED");
    assert.equal(hold(i1, asset).locked_tokens, 1000n);
    assert.equal(hold(owner, asset).available_tokens, 99_000n);
    assert.ok(L.checkInvariants(asset).ok);
  });

  it("chống bán vượt nhờ giữ chỗ token của đơn chờ thanh toán", () => {
    const { L, i1, i2, asset } = scenario();
    L.createPrimaryOrder(i1, asset, 60_000);
    assert.throws(() => L.createPrimaryOrder(i2, asset, 50_000), /Chỉ còn 40000/);
  });

  it("yêu cầu eKYC trước khi mua", () => {
    const { L, user, asset } = scenario();
    const noKyc = user("nokyc");
    assert.throws(() => L.createPrimaryOrder(noKyc, asset, 10), { code: "KYC_REQUIRED" });
  });

  it("tiền về muộn cho đơn đã hủy → lập lệnh hoàn tiền, không cộng token", () => {
    const { L, db, i1, asset } = scenario();
    const o = L.createPrimaryOrder(i1, asset, 100);
    L.cancelOrder(i1, o.transaction_id);
    assert.equal(L.handleBankPayment({ reference_code: o.reference_code, amount: o.amount }).result, "LATE_PAYMENT_REFUND_QUEUED");
    assert.ok(db.get("SELECT 1 FROM transactions WHERE type = 'REFUND' AND user_id = ?", i1));
    assert.ok(L.checkInvariants(asset).ok);
  });
});

describe("Kết thúc gọi vốn", () => {
  it("kích hoạt: mở khóa token, giữ quỹ dự phòng 6 tháng cho bán & thuê lại", () => {
    const s = scenario();
    const a2 = s.newAsset(s.owner, { is_sale_leaseback: true, monthly_rent_commitment: 5_000_000 });
    s.pay(s.L.createPrimaryOrder(s.i1, a2, 20_000));
    const r = s.L.activateAsset(s.adminId, a2);
    assert.equal(r.raised, 200_000_000n);
    assert.equal(r.reserve, 30_000_000n);
    assert.equal(r.disbursement, 170_000_000n);
    assert.equal(s.hold(s.i1, a2).available_tokens, 20_000n);
    assert.equal(s.hold(s.i1, a2).locked_tokens, 0n);
  });

  it("không đạt Soft Cap thì không kích hoạt; hủy gọi vốn hoàn 100%", () => {
    const { L, adminId, i1, asset, pay, hold, owner } = scenario();
    pay(L.createPrimaryOrder(i1, asset, 500));
    assert.throws(() => L.activateAsset(adminId, asset), /Soft Cap/);
    const r = L.failFunding(adminId, asset);
    assert.equal(r.refunds, 1);
    assert.equal(hold(i1, asset).locked_tokens, 0n);
    assert.equal(hold(owner, asset).available_tokens, 100_000n);
  });
});

describe("Chia cổ tức", () => {
  it("trừ phí sàn 5%, thưởng vận hành trên phần tăng thêm, thuế TNCN 5%, làm tròn xuống", () => {
    const { L, adminId, owner, i1, i2, asset, pay, db } = scenario();
    pay(L.createPrimaryOrder(i1, asset, 60_000));
    pay(L.createPrimaryOrder(i2, asset, 20_000));
    L.activateAsset(adminId, asset);
    // i1 đề xuất nâng giá trị, thưởng 10%; i1 + owner = 80% > 75% → thông qua
    const pid = L.createProposal(i1, asset, { proposal_type: "VALUE_ADD_5_10_PERCENT", title: "x", reward_bps: 1000 });
    L.castVote(pid, i1, "AGREE");
    assert.equal(L.castVote(pid, owner, "AGREE").status, "APPROVED");

    const r = L.distributeMonthlyRent(adminId, asset, 12_000_000, { period: "2026-10" });
    assert.equal(r.platformFee, 600_000n);
    assert.equal(r.operatorReward, 200_000n); // 10% x (12tr - 10tr cơ sở)
    assert.equal(r.netDistributableAmount, 11_200_000n);
    const l1 = r.lines.find((l) => l.user_id === i1);
    assert.equal(l1.gross, 6_720_000n);
    assert.equal(l1.tax, 336_000n);
    assert.equal(l1.net, 6_384_000n);
    assert.throws(() => L.distributeMonthlyRent(adminId, asset, 1, { period: "2026-10" }), /đã được chia/);
    const csv = L.batchCsv(r.batchId);
    assert.match(csv, /6384000/);
    assert.equal(db.get("SELECT COUNT(*) AS n FROM transactions WHERE batch_id = ?", r.batchId).n, 4n);
  });
});

describe("Biểu quyết", () => {
  it("cần > 75% tổng token, cấm biểu quyết 2 lần, khóa chuyển nhượng khi đã biểu quyết", () => {
    const { L, adminId, owner, i1, asset, pay } = scenario();
    pay(L.createPrimaryOrder(i1, asset, 30_000));
    L.activateAsset(adminId, asset);
    const pid = L.createProposal(i1, asset, { proposal_type: "FULL_EXIT_SALE", title: "Bán", proposed_price: 1_500_000_000 });
    assert.equal(L.castVote(pid, i1, "AGREE").status, "VOTING");
    assert.throws(() => L.castVote(pid, i1, "AGREE"), /đã biểu quyết/);
    assert.throws(() => L.exchange.placeOrder(i1, { asset_id: asset, side: "SELL", price: 10_000, quantity: 10 }), /bị khóa chuyển nhượng/);
    // owner 70% phản đối → không thể vượt 75% → bác bỏ sớm
    assert.equal(L.castVote(pid, owner, "DISAGREE").status, "REJECTED");
  });
});

describe("Ma trận thoái vốn", () => {
  it("Drag-Along bán lỗ: cổ đông nhỏ nhận đủ mệnh giá gốc, chủ cũ gánh lỗ", () => {
    const { L, adminId, owner, i1, asset, pay } = scenario({ soft_cap_bps: 300 });
    pay(L.createPrimaryOrder(i1, asset, 5_000)); // owner giữ 95%
    L.activateAsset(adminId, asset);
    const r = L.calculateExitPayout(asset, 800_000_000);
    assert.equal(r.mode, "DRAG_ALONG_LOSS");
    assert.equal(r.lines.find((l) => l.user_id === i1).amount, 50_000_000n);
    assert.equal(r.lines.find((l) => l.user_id === owner).amount, 750_000_000n);
  });

  it("Drag-Along bán lãi: chia đúng tỷ lệ", () => {
    const { L, adminId, i1, asset, pay } = scenario({ soft_cap_bps: 300 });
    pay(L.createPrimaryOrder(i1, asset, 5_000));
    L.activateAsset(adminId, asset);
    const r = L.calculateExitPayout(asset, 1_200_000_000);
    assert.equal(r.mode, "DRAG_ALONG_PROFIT");
    assert.equal(r.lines.find((l) => l.user_id === i1).amount, 60_000_000n);
    assert.equal(r.lines.reduce((s, l) => s + l.amount, 0n), 1_200_000_000n);
  });

  it("Cổ đông phân tán: bắt buộc đề xuất đã thông qua, rồi chia theo tỷ lệ và hủy niêm yết", () => {
    const { L, db, adminId, owner, i1, asset, pay } = scenario();
    pay(L.createPrimaryOrder(i1, asset, 30_000));
    L.activateAsset(adminId, asset);
    assert.throws(() => L.calculateExitPayout(asset, 900_000_000), { code: "VOTE_REQUIRED" });
    const pid = L.createProposal(i1, asset, { proposal_type: "FULL_EXIT_SALE", title: "Bán", proposed_price: 900_000_000 });
    L.castVote(pid, i1, "AGREE");
    L.castVote(pid, owner, "AGREE");
    const r = L.executeExit(adminId, asset, 900_000_000);
    assert.equal(r.mode, "VOTED_PRO_RATA");
    assert.equal(r.lines.find((l) => l.user_id === i1).amount, 270_000_000n);
    assert.equal(db.get("SELECT status FROM assets WHERE id = ?", asset).status, "DELISTED");
  });
});

function market() {
  const s = scenario();
  const { L, adminId, i1, i2, asset, pay } = s;
  pay(L.createPrimaryOrder(i1, asset, 20_000));
  pay(L.createPrimaryOrder(i2, asset, 10_000));
  L.activateAsset(adminId, asset);
  const deposit = (u, amt) => {
    const d = L.exchange.createDeposit(u, amt);
    return L.handleBankPayment({ reference_code: d.reference_code, amount: d.amount });
  };
  const cashOf = (u) => s.db.get("SELECT * FROM cash_accounts WHERE user_id = ?", u);
  const order = (u, o) => L.exchange.placeOrder(u, { asset_id: asset, type: "LIMIT", ...o });
  return { ...s, ex: L.exchange, deposit, cashOf, order };
}

describe("Ví tiền", () => {
  it("nạp qua webhook ghi có số tiền thực nhận; rút tạo bảng kê chờ duyệt", () => {
    const { deposit, cashOf, i1, L, db } = market();
    assert.equal(deposit(i1, 5_000_000).result, "COMPLETED");
    assert.equal(cashOf(i1).available, 5_000_000n);
    const w = L.exchange.requestWithdrawal(i1, 1_000_000);
    assert.equal(cashOf(i1).available, 4_000_000n);
    assert.equal(db.get("SELECT status FROM transactions WHERE id = ?", w.transaction_id).status, "AWAITING_PAYOUT");
    assert.throws(() => L.exchange.requestWithdrawal(i1, 99_000_000), { code: "INSUFFICIENT_CASH" });
  });

  it("mua sơ cấp bằng số dư ví hoàn tất ngay", () => {
    const s = scenario();
    const d = s.L.exchange.createDeposit(s.i1, 1_000_000);
    s.L.handleBankPayment({ reference_code: d.reference_code, amount: d.amount });
    const r = s.L.createPrimaryOrder(s.i1, s.asset, 100, { fromWallet: true });
    assert.equal(r.paid_from_wallet, true);
    assert.equal(s.hold(s.i1, s.asset).locked_tokens, 100n);
    assert.equal(s.db.get("SELECT available FROM cash_accounts WHERE user_id = ?", s.i1).available, 0n);
  });
});

describe("Sàn khớp lệnh", () => {
  it("khớp ưu tiên giá → thời gian tại giá lệnh chờ; phí 0,15% mỗi bên, thuế bán 0,1%", () => {
    const { ex, order, deposit, cashOf, hold, i1, i2, user, kyc, asset, db } = market();
    const i3 = user("i3");
    kyc(i3);
    deposit(i3, 50_000_000);
    order(i1, { side: "SELL", price: 10_200, quantity: 300 }); // A1
    order(i2, { side: "SELL", price: 10_100, quantity: 200 }); // A2 – giá tốt hơn
    order(i1, { side: "SELL", price: 10_100, quantity: 100 }); // A3 – cùng giá, đến sau
    const o = order(i3, { side: "BUY", price: 10_200, quantity: 400 });
    assert.equal(o.status, "FILLED");
    const trades = db.all("SELECT price, quantity, seller_id FROM trades ORDER BY id");
    assert.deepEqual(trades.map((t) => [t.price, t.quantity, t.seller_id]), [
      [10_100n, 200n, i2],
      [10_100n, 100n, i1],
      [10_200n, 100n, i1],
    ]);
    const cost = 300n * 10_100n + 100n * 10_200n; // 4.050.000
    const buyerFee = (200n * 10_100n * 15n) / 10000n + (100n * 10_100n * 15n) / 10000n + (100n * 10_200n * 15n) / 10000n;
    assert.equal(cashOf(i3).available, 50_000_000n - cost - buyerFee);
    assert.equal(cashOf(i3).locked, 0n);
    assert.equal(hold(i3, asset).available_tokens, 400n);
    // i2 bán 200 @ 10.100 = 2.020.000, phí 3.030, thuế 2.020
    assert.equal(cashOf(i2).available, 2_020_000n - 3_030n - 2_020n);
    assert.equal(hold(i1, asset).locked_tokens, 200n); // còn 200 của lệnh A1
    assert.equal(ex.depth(asset).asks[0].price, 10_200n);
  });

  it("lệnh khớp một phần nằm lại sổ; hủy thì hoàn đúng phần phong tỏa", () => {
    const { order, deposit, cashOf, i1, i2, ex } = market();
    deposit(i2, 10_000_000);
    order(i1, { side: "SELL", price: 10_000, quantity: 100 });
    const b = order(i2, { side: "BUY", price: 10_000, quantity: 300 });
    assert.equal(b.status, "PARTIAL");
    assert.equal(b.locked_cash, ex.reserveFor(200n, 10_000n));
    ex.cancelOrder(i2, b.id);
    assert.equal(cashOf(i2).locked, 0n);
    assert.equal(cashOf(i2).available, 10_000_000n - 1_000_000n - 1_500n);
  });

  it("lệnh thị trường (MP) khớp đến hết thanh khoản rồi hủy phần còn lại, hoàn tiền phong tỏa dư", () => {
    const { order, deposit, cashOf, i1, i2, ex, asset } = market();
    deposit(i2, 10_000_000);
    order(i1, { side: "SELL", price: 10_000, quantity: 100 });
    order(i1, { side: "SELL", price: 10_500, quantity: 100 });
    const m = ex.placeOrder(i2, { asset_id: asset, side: "BUY", type: "MARKET", quantity: 500 });
    assert.equal(m.status, "CANCELLED");
    assert.equal(m.filled_quantity, 200n);
    assert.equal(cashOf(i2).locked, 0n);
    const spent = 1_000_000n + 1_050_000n + 1_500n + 1_575n;
    assert.equal(cashOf(i2).available, 10_000_000n - spent);
  });

  it("kiểm tra biên độ giá ±10% và bước giá", () => {
    const { order, i1 } = market();
    assert.throws(() => order(i1, { side: "SELL", price: 11_010, quantity: 1 }), { code: "OUT_OF_BAND" });
    assert.throws(() => order(i1, { side: "SELL", price: 8_990, quantity: 1 }), { code: "OUT_OF_BAND" });
    assert.throws(() => order(i1, { side: "SELL", price: 10_005, quantity: 1 }), /bước giá/);
    assert.equal(order(i1, { side: "SELL", price: 11_000, quantity: 1 }).status, "OPEN");
  });

  it("lệnh dừng (stop-limit) kích hoạt khi giá khớp chạm ngưỡng", () => {
    const { order, deposit, i1, i2, ex, asset, db } = market();
    deposit(i2, 20_000_000);
    const stop = ex.placeOrder(i1, { asset_id: asset, side: "SELL", type: "STOP_LIMIT", stop_price: 9_800, price: 9_700, quantity: 50 });
    assert.equal(stop.status, "PENDING_TRIGGER");
    order(i2, { side: "BUY", price: 9_700, quantity: 50 }); // bid chờ cho lệnh dừng
    order(i1, { side: "SELL", price: 9_800, quantity: 10 });
    order(i2, { side: "BUY", price: 9_800, quantity: 10 }); // khớp 9.800 → kích hoạt
    assert.equal(db.get("SELECT status FROM orders WHERE id = ?", stop.id).status, "FILLED");
  });

  it("chống tự khớp: lệnh chờ của chính mình bị hủy thay vì khớp", () => {
    const { order, deposit, i1, db } = market();
    deposit(i1, 5_000_000);
    const sell = order(i1, { side: "SELL", price: 10_000, quantity: 10 });
    order(i1, { side: "BUY", price: 10_000, quantity: 10 });
    assert.equal(db.get("SELECT status, cancel_reason FROM orders WHERE id = ?", sell.id).cancel_reason, "SELF_TRADE_PREVENTION");
    assert.equal(db.get("SELECT COUNT(*) AS n FROM trades").n, 0n);
  });

  it("tạm ngừng giao dịch hủy toàn bộ lệnh, hoàn tiền & token; cảnh báo giá kích hoạt", () => {
    const { order, deposit, cashOf, hold, i1, i2, ex, asset, L, adminId, db } = market();
    deposit(i2, 5_000_000);
    ex.createAlert(i2, asset, "BELOW", 9_900);
    order(i1, { side: "SELL", price: 9_900, quantity: 10 });
    order(i2, { side: "BUY", price: 9_900, quantity: 10 });
    assert.ok(db.get("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Cảnh báo giá%'", i2));
    order(i1, { side: "SELL", price: 10_500, quantity: 500 });
    order(i2, { side: "BUY", price: 9_500, quantity: 100 });
    L.triggerPlanningHalt(adminId, asset, "https://example.gov.vn/tb.pdf");
    assert.equal(hold(i1, asset).locked_tokens, 0n);
    assert.equal(cashOf(i2).locked, 0n);
    assert.throws(() => order(i1, { side: "SELL", price: 10_000, quantity: 1 }), { code: "NOT_TRADING" });
    assert.ok(L.checkInvariants(asset).ok);
  });

  it("bảo toàn tiền: tổng nạp = số dư + phí + thuế", () => {
    const { order, deposit, i1, i2, db } = market();
    deposit(i1, 3_000_000);
    deposit(i2, 7_000_000);
    order(i1, { side: "SELL", price: 10_300, quantity: 77 });
    order(i2, { side: "BUY", price: 10_400, quantity: 123 });
    order(i1, { side: "SELL", price: 10_000, quantity: 99 });
    const bal = db.get("SELECT SUM(available + locked) AS s FROM cash_accounts").s;
    const fees = db.get("SELECT SUM(buyer_fee + seller_fee + seller_tax) AS s FROM trades").s;
    assert.equal(bal + fees, 10_000_000n);
  });
});

describe("Nhật ký kiểm toán", () => {
  it("không cho UPDATE/DELETE và chuỗi băm hợp lệ", () => {
    const { db } = scenario();
    assert.throws(() => db.run("UPDATE audit_logs SET action = 'x'"), /append-only/);
    assert.throws(() => db.run("DELETE FROM audit_logs"), /append-only/);
    assert.deepEqual(db.verifyAuditChain(), { ok: true });
  });
});

describe("HTTP API – bảo mật", () => {
  it("webhook sai chữ ký bị từ chối; chống IDOR; chặn quyền admin", async () => {
    const app = createApp({ config, db: openDb(":memory:") });
    const server = createServer(app.handler).listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (path, { token, body, headers = {} } = {}) => {
      const res = await fetch(base + path, {
        method: body !== undefined ? "POST" : "GET",
        headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }), ...headers },
        body: typeof body === "string" ? body : body && JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    try {
      const reg = (email) => call("/api/auth/register", { body: { full_name: "A", email, password: "Password1!" } });
      const a = (await reg("a@t.vn")).data;
      const b = (await reg("b@t.vn")).data;
      // Không tự nâng quyền ADMIN được
      const sneaky = await call("/api/auth/register", { body: { full_name: "X", email: "x@t.vn", password: "Password1!", role: "ADMIN" } });
      assert.equal(sneaky.data.user.role, "INVESTOR");
      assert.equal((await call("/api/admin/overview", { token: a.token })).status, 403);
      assert.equal((await call("/api/portfolio")).status, 401);
      assert.equal((await call("/api/portfolio", { token: "abc.def.ghi" })).status, 401);

      // Tạo 1 đơn cho user A trực tiếp qua ledger rồi để user B thử đọc
      app.db.run("UPDATE users SET kyc_status = 'VERIFIED'");
      const owner = app.ledger.registerUser({ full_name: "O", email: "o@t.vn", password: "Password1!", role: "OWNER" });
      app.db.run("UPDATE users SET kyc_status = 'VERIFIED' WHERE id = ?", owner.id);
      const spv = app.ledger.createSpv(null, { company_name: "S", tax_code: "1", bank_custodian_name: "B" });
      const asset = app.ledger.submitAsset(owner.id, { asset_type: "ANTIQUE", title: "Bình", valuation_amount: 100_000_000 });
      app.ledger.approveAsset(null, asset.id, { spv_id: spv });
      const order = await call("/api/orders/create", { token: a.token, body: { asset_id: asset.id, token_amount: 10 } });
      assert.equal(order.status, 200);
      assert.equal((await call(`/api/orders/${order.data.transaction_id}`, { token: b.token })).status, 404);
      assert.equal((await call(`/api/orders/${order.data.transaction_id}/cancel`, { token: b.token, body: {} })).status, 404);

      const raw = JSON.stringify({ reference_code: order.data.reference_code, amount: "100000" });
      assert.equal((await call("/api/webhooks/bank-payment", { body: raw, headers: { "x-signature": "00".repeat(32) } })).status, 401);
      const ok = await call("/api/webhooks/bank-payment", { body: raw, headers: { "x-signature": hmacHex(raw, config.webhookSecret) } });
      assert.equal(ok.data.result, "COMPLETED");
      const pf = await call("/api/portfolio", { token: a.token });
      assert.equal(pf.data.holdings[0].locked_tokens, "10");
    } finally {
      server.close();
    }
  });
});
