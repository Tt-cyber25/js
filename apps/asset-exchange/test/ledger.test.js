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
  otcFeeBps: 50n,
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
    assert.throws(() => L.createOtcListing(i1, asset, 10, 11_000), /bị khóa chuyển nhượng/);
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

describe("OTC & tạm ngừng giao dịch", () => {
  it("khớp lệnh OTC chuyển token, trừ phí người bán; tạm ngừng hủy lệnh và trả token", () => {
    const { L, db, adminId, i1, i2, asset, pay, hold } = scenario();
    pay(L.createPrimaryOrder(i1, asset, 20_000));
    L.activateAsset(adminId, asset);
    const listing = L.createOtcListing(i1, asset, 5_000, 12_000);
    pay(L.createOtcOrder(i2, listing, 2_000));
    assert.equal(hold(i2, asset).available_tokens, 2_000n);
    assert.equal(hold(i1, asset).locked_tokens, 3_000n);
    const sale = db.get("SELECT * FROM transactions WHERE type = 'SELL_OTC' AND user_id = ?", i1);
    assert.equal(sale.fee_amount, 120_000n);
    assert.equal(sale.net_amount, 23_880_000n);

    const pending = L.createOtcOrder(i2, listing, 1_000);
    L.triggerPlanningHalt(adminId, asset, "https://example.gov.vn/thong-bao.pdf");
    assert.equal(hold(i1, asset).locked_tokens, 0n);
    assert.equal(hold(i1, asset).available_tokens, 18_000n);
    assert.equal(db.get("SELECT status FROM transactions WHERE id = ?", pending.transaction_id).status, "CANCELLED");
    assert.throws(() => L.createOtcListing(i1, asset, 10, 10_000), /không cho phép/);
    assert.ok(L.checkInvariants(asset).ok);
    assert.ok(db.get("SELECT 1 FROM notifications WHERE user_id = ? AND severity = 'CRITICAL'", i2));
  });

  it("hủy lệnh bán khi còn đơn đang giữ chỗ: đơn hết hạn thì token trả về người bán", () => {
    const { L, db, adminId, i1, i2, asset, pay, hold } = scenario();
    pay(L.createPrimaryOrder(i1, asset, 20_000));
    L.activateAsset(adminId, asset);
    const listing = L.createOtcListing(i1, asset, 5_000, 12_000);
    const o = L.createOtcOrder(i2, listing, 1_000);
    L.cancelListing(i1, listing);
    assert.equal(hold(i1, asset).locked_tokens, 1_000n);
    db.run("UPDATE transactions SET expires_at = datetime('now', '-1 minute') WHERE id = ?", o.transaction_id);
    assert.equal(L.expireStaleOrders(), 1);
    assert.equal(hold(i1, asset).locked_tokens, 0n);
    assert.equal(hold(i1, asset).available_tokens, 20_000n);
    assert.throws(() => L.createOtcOrder(i2, listing, 1), /không còn hiệu lực/);
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
