// SÀN KHỚP LỆNH LIÊN TỤC (Continuous Order Book Matching Engine) + VÍ TIỀN
// - Ưu tiên giá → thời gian (price-time priority), khớp tại giá của lệnh chờ (maker).
// - Biên độ giá ±BAND quanh giá tham chiếu (giá đóng cửa ngày trước), bước giá TICK.
// - Lệnh LO (giới hạn), MP (thị trường), STOP_LIMIT (lệnh điều kiện dừng).
// - Chống tự khớp (self-trade prevention): lệnh chờ của chính mình bị hủy.
// - Mọi thao tác chạy trong db.tx() của bên gọi; tiền/token là BigInt.
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./auth.js";

const BPS = 10000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;
const VN_OFFSET_MS = 7 * 3600 * 1000;

/** Thời điểm 00:00 hôm nay theo giờ Việt Nam, dạng chuỗi UTC của SQLite. */
export function vnDayStartSql(now = Date.now()) {
  const vn = new Date(now + VN_OFFSET_MS);
  const startUtc = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate()) - VN_OFFSET_MS;
  return new Date(startUtc).toISOString().replace("T", " ").slice(0, 19);
}

export function createExchange(db, config, h) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const tick = config.tickSize;
  const feeBps = config.tradeFeeBps;
  const taxBps = config.sellTaxBps;
  const fee = (value) => (value * feeBps) / BPS;
  // Số tiền cần phong tỏa cho q token ở giá p (gồm phí tối đa)
  const reserveFor = (q, p) => q * p + ceilDiv(q * p * feeBps, BPS);

  // ---------- Ví tiền ----------
  const cash = (userId) => {
    let c = db.get("SELECT * FROM cash_accounts WHERE user_id = ?", userId);
    if (!c) {
      db.run("INSERT INTO cash_accounts (user_id) VALUES (?)", userId);
      c = db.get("SELECT * FROM cash_accounts WHERE user_id = ?", userId);
    }
    return c;
  };
  const creditCash = (userId, amount) => {
    cash(userId);
    db.run("UPDATE cash_accounts SET available = available + ? WHERE user_id = ?", amount, userId);
  };
  const debitCash = (userId, amount) => {
    const c = cash(userId);
    if (c.available < amount) throw new HttpError(409, "Số dư tiền không đủ", "INSUFFICIENT_CASH");
    db.run("UPDATE cash_accounts SET available = available - ? WHERE user_id = ?", amount, userId);
  };

  // ---------- Giá tham chiếu & biên độ ----------
  function referencePrice(asset) {
    const t = db.get("SELECT price FROM trades WHERE asset_id = ? AND created_at < ? ORDER BY id DESC LIMIT 1", asset.id, vnDayStartSql());
    return t ? t.price : asset.token_price;
  }
  function priceBand(asset) {
    const ref = referencePrice(asset);
    const up = (ref * (BPS + config.bandBps)) / BPS;
    const down = ceilDiv(ref * (BPS - config.bandBps), BPS);
    return { ref, ceiling: (up / tick) * tick, floor: ceilDiv(down, tick) * tick };
  }
  const lastPrice = (asset) =>
    db.get("SELECT price FROM trades WHERE asset_id = ? ORDER BY id DESC LIMIT 1", asset.id)?.price ?? referencePrice(asset);

  // ---------- Đặt lệnh ----------
  function placeOrder(userId, input) {
    h.requireKyc(userId);
    const side = input.side;
    if (side !== "BUY" && side !== "SELL") throw new HttpError(400, "Chiều lệnh phải là BUY hoặc SELL");
    const type = input.type ?? "LIMIT";
    if (!["LIMIT", "MARKET", "STOP_LIMIT"].includes(type)) throw new HttpError(400, "Loại lệnh không hợp lệ");
    const qty = h.toBig(input.quantity, "khối lượng", { max: 10n ** 12n });
    const tif = type === "MARKET" ? "IOC" : input.tif === "IOC" ? "IOC" : "GTC";

    return db.tx(() => {
      const a = h.getAsset(String(input.asset_id || ""));
      if (a.status !== "ACTIVE") throw new HttpError(409, "Tài sản không trong trạng thái giao dịch", "NOT_TRADING");
      const band = priceBand(a);
      let price = null;
      let stop = null;
      if (type !== "MARKET") {
        price = h.toBig(input.price, "giá");
        if (price % tick !== 0n) throw new HttpError(400, `Giá phải là bội số của bước giá ${tick}đ`);
        if (price > band.ceiling || price < band.floor) {
          throw new HttpError(400, `Giá phải nằm trong biên độ ${band.floor} – ${band.ceiling}`, "OUT_OF_BAND");
        }
      }
      if (type === "STOP_LIMIT") {
        stop = h.toBig(input.stop_price, "giá kích hoạt");
        if (stop % tick !== 0n) throw new HttpError(400, `Giá kích hoạt phải là bội số của ${tick}đ`);
      }
      // Lệnh thị trường phong tỏa theo giá trần (mua) / không phong tỏa tiền (bán)
      const reservePrice = type === "MARKET" ? band.ceiling : price;
      let lockedCash = 0n;
      if (side === "BUY") {
        lockedCash = reserveFor(qty, reservePrice);
        const c = cash(userId);
        if (c.available < lockedCash) throw new HttpError(409, `Số dư không đủ: cần ${lockedCash}đ (gồm phí)`, "INSUFFICIENT_CASH");
        db.run("UPDATE cash_accounts SET available = available - ?, locked = locked + ? WHERE user_id = ?", lockedCash, lockedCash, userId);
      } else {
        if (h.hasActiveVote(userId, a.id)) {
          throw new HttpError(409, "Token đã dùng để biểu quyết bị khóa chuyển nhượng đến khi kết thúc biểu quyết");
        }
        const hold = h.holding(userId, a.id);
        if (hold.available_tokens < qty) throw new HttpError(409, "Không đủ token khả dụng", "INSUFFICIENT_TOKENS");
        db.run(
          "UPDATE user_holdings SET available_tokens = available_tokens - ?, locked_tokens = locked_tokens + ? WHERE id = ?",
          qty,
          qty,
          hold.id,
        );
      }
      const id = randomUUID();
      const status = type === "STOP_LIMIT" ? "PENDING_TRIGGER" : "OPEN";
      db.run(
        `INSERT INTO orders (id, user_id, asset_id, side, type, price, stop_price, quantity, locked_cash, tif, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        userId,
        a.id,
        side,
        type,
        price,
        stop,
        qty,
        lockedCash,
        tif,
        status,
      );
      db.audit(userId, "ORDER_PLACED", "orders", id, { asset: a.asset_code, side, type, price, stop, qty });
      // Lệnh dừng kích hoạt ngay nếu điều kiện đã thỏa
      if (type !== "STOP_LIMIT" || stopTriggered(side, stop, lastPrice(a))) {
        if (type === "STOP_LIMIT") db.run("UPDATE orders SET status = 'OPEN' WHERE id = ?", id);
        match(id);
        processStops(a);
      }
      events.emit("market", a.id);
      return getOrder(id);
    });
  }

  const getOrder = (id) => db.get("SELECT * FROM orders WHERE id = ?", id);
  const stopTriggered = (side, stop, last) => (side === "BUY" ? last >= stop : last <= stop);

  function match(orderId) {
    const o = getOrder(orderId);
    const opp = o.side === "BUY" ? "SELL" : "BUY";
    const priceCond = o.type === "MARKET" ? "" : o.side === "BUY" ? "AND price <= ?" : "AND price >= ?";
    const orderBy = o.side === "BUY" ? "price ASC, rowid ASC" : "price DESC, rowid ASC";
    let remaining = o.quantity - o.filled_quantity;
    while (remaining > 0n) {
      const params = [o.asset_id, opp];
      if (priceCond) params.push(o.price);
      const maker = db.get(
        `SELECT * FROM orders WHERE asset_id = ? AND side = ? AND status IN ('OPEN','PARTIAL') ${priceCond} ORDER BY ${orderBy} LIMIT 1`,
        ...params,
      );
      if (!maker) break;
      if (maker.user_id === o.user_id) {
        // Chống tự khớp: hủy lệnh chờ của chính người đặt
        cancelInternal(maker, "SELF_TRADE_PREVENTION");
        continue;
      }
      const qty = remaining < maker.quantity - maker.filled_quantity ? remaining : maker.quantity - maker.filled_quantity;
      execute(o.side === "BUY" ? getOrder(o.id) : maker, o.side === "BUY" ? maker : getOrder(o.id), maker.price, qty, o.side);
      remaining -= qty;
    }
    const after = getOrder(o.id);
    if (after.status === "OPEN" || after.status === "PARTIAL") {
      if (after.tif === "IOC") cancelInternal(after, o.type === "MARKET" ? "MARKET_REMAINDER" : "IOC_REMAINDER");
    } else if (after.status === "FILLED" && after.side === "BUY" && after.locked_cash > 0n) {
      // Lệnh MP mua khớp hết: hoàn phần phong tỏa dư (đã phong tỏa theo giá trần)
      db.run("UPDATE cash_accounts SET locked = locked - ?, available = available + ? WHERE user_id = ?", after.locked_cash, after.locked_cash, after.user_id);
      db.run("UPDATE orders SET locked_cash = 0 WHERE id = ?", after.id);
    }
  }

  function execute(buy, sell, price, qty, takerSide) {
    const value = price * qty;
    const buyerFee = fee(value);
    const sellerFee = fee(value);
    const sellerTax = (value * taxBps) / BPS;

    // Bên mua: giải phóng phần phong tỏa tương ứng, trừ chi phí thực tế
    const buyRemainingAfter = buy.quantity - buy.filled_quantity - qty;
    let newLocked;
    if (buy.type === "MARKET") {
      newLocked = buy.locked_cash - value - buyerFee; // lệnh MP: trừ thẳng, phần dư hoàn khi hủy phần còn lại
      if (newLocked < 0n) throw new HttpError(500, "Phong tỏa lệnh thị trường không đủ");
    } else {
      newLocked = buyRemainingAfter === 0n ? 0n : reserveFor(buyRemainingAfter, buy.price);
    }
    const released = buy.locked_cash - newLocked; // tiền rời khỏi phần phong tỏa
    const refund = released - value - buyerFee; // phần thừa (khớp giá tốt hơn) trả về khả dụng
    db.run("UPDATE cash_accounts SET locked = locked - ?, available = available + ? WHERE user_id = ?", released, refund, buy.user_id);
    h.creditBuyer(buy.user_id, buy.asset_id, qty, price, { locked: false });

    // Bên bán: trừ token phong tỏa, nhận tiền sau phí & thuế
    db.run("UPDATE user_holdings SET locked_tokens = locked_tokens - ? WHERE user_id = ? AND asset_id = ?", qty, sell.user_id, sell.asset_id);
    creditCash(sell.user_id, value - sellerFee - sellerTax);

    const upd = (o, lockedCash) =>
      db.run(
        `UPDATE orders SET filled_quantity = filled_quantity + ?, filled_value = filled_value + ?, locked_cash = ?,
                status = CASE WHEN filled_quantity + ? = quantity THEN 'FILLED' ELSE 'PARTIAL' END, updated_at = datetime('now')
          WHERE id = ?`,
        qty,
        value,
        lockedCash,
        qty,
        o.id,
      );
    upd(buy, newLocked);
    upd(sell, 0n);
    db.run(
      `INSERT INTO trades (asset_id, price, quantity, buy_order_id, sell_order_id, buyer_id, seller_id, taker_side, buyer_fee, seller_fee, seller_tax)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      buy.asset_id,
      price,
      qty,
      buy.id,
      sell.id,
      buy.user_id,
      sell.user_id,
      takerSide,
      buyerFee,
      sellerFee,
      sellerTax,
    );
    db.run("INSERT INTO price_history (asset_id, price) VALUES (?,?)", buy.asset_id, price);
    checkAlerts(buy.asset_id, price);
  }

  function processStops(asset) {
    for (let guard = 0; guard < 100; guard++) {
      const last = lastPrice(asset);
      const trig = db.get(
        `SELECT * FROM orders WHERE asset_id = ? AND status = 'PENDING_TRIGGER'
           AND ((side = 'BUY' AND stop_price <= ?) OR (side = 'SELL' AND stop_price >= ?)) ORDER BY rowid LIMIT 1`,
        asset.id,
        last,
        last,
      );
      if (!trig) return;
      const band = priceBand(asset);
      if (trig.price > band.ceiling || trig.price < band.floor) {
        cancelInternal(trig, "OUT_OF_BAND_ON_TRIGGER");
        continue;
      }
      db.run("UPDATE orders SET status = 'OPEN', updated_at = datetime('now') WHERE id = ?", trig.id);
      db.notify(trig.user_id, "Lệnh điều kiện đã kích hoạt", `Lệnh ${trig.side === "BUY" ? "mua" : "bán"} ${trig.quantity} @ ${trig.price} đã vào sổ lệnh.`);
      match(trig.id);
    }
  }

  function cancelInternal(o, reason) {
    const remaining = o.quantity - o.filled_quantity;
    if (o.side === "BUY") {
      db.run("UPDATE cash_accounts SET locked = locked - ?, available = available + ? WHERE user_id = ?", o.locked_cash, o.locked_cash, o.user_id);
    } else {
      db.run(
        "UPDATE user_holdings SET locked_tokens = locked_tokens - ?, available_tokens = available_tokens + ? WHERE user_id = ? AND asset_id = ?",
        remaining,
        remaining,
        o.user_id,
        o.asset_id,
      );
    }
    db.run("UPDATE orders SET status = 'CANCELLED', locked_cash = 0, cancel_reason = ?, updated_at = datetime('now') WHERE id = ?", reason, o.id);
  }

  function cancelOrder(userId, orderId) {
    return db.tx(() => {
      const o = getOrder(orderId);
      if (!o || o.user_id !== userId) throw new HttpError(404, "Không tìm thấy lệnh");
      if (!["OPEN", "PARTIAL", "PENDING_TRIGGER"].includes(o.status)) throw new HttpError(409, "Lệnh đã kết thúc");
      cancelInternal(o, "USER");
      db.audit(userId, "ORDER_CANCELLED", "orders", orderId, {});
      events.emit("market", o.asset_id);
    });
  }

  /** Hủy toàn bộ lệnh của 1 tài sản (tạm ngừng / hủy niêm yết). Gọi bên trong tx. */
  function cancelAllForAsset(assetId, reason) {
    const list = db.all("SELECT * FROM orders WHERE asset_id = ? AND status IN ('OPEN','PARTIAL','PENDING_TRIGGER')", assetId);
    for (const o of list) {
      cancelInternal(o, reason);
      db.notify(o.user_id, "Lệnh bị hủy", `Lệnh ${o.side === "BUY" ? "mua" : "bán"} đã bị hủy do ${reason === "HALT" ? "tạm ngừng giao dịch" : "tài sản hủy niêm yết"}.`, "WARNING");
    }
    events.emit("market", assetId);
    return list.length;
  }

  // ---------- Cảnh báo giá ----------
  function checkAlerts(assetId, price) {
    const hits = db.all(
      "SELECT * FROM price_alerts WHERE asset_id = ? AND active = 1 AND ((direction = 'ABOVE' AND price <= ?) OR (direction = 'BELOW' AND price >= ?))",
      assetId,
      price,
      price,
    );
    for (const al of hits) {
      const a = h.getAsset(assetId);
      db.run("UPDATE price_alerts SET active = 0, triggered_at = datetime('now') WHERE id = ?", al.id);
      db.notify(al.user_id, `Cảnh báo giá ${a.asset_code}`, `Giá khớp ${price}đ đã ${al.direction === "ABOVE" ? "vượt lên" : "giảm xuống"} mức ${al.price}đ.`, "WARNING");
    }
  }

  function createAlert(userId, assetId, direction, price) {
    if (direction !== "ABOVE" && direction !== "BELOW") throw new HttpError(400, "Hướng cảnh báo không hợp lệ");
    const p = h.toBig(price, "giá cảnh báo");
    return db.tx(() => {
      h.getAsset(assetId);
      if (db.get("SELECT COUNT(*) AS n FROM price_alerts WHERE user_id = ? AND active = 1", userId).n >= 50n) {
        throw new HttpError(409, "Tối đa 50 cảnh báo đang hoạt động");
      }
      const id = randomUUID();
      db.run("INSERT INTO price_alerts (id, user_id, asset_id, direction, price) VALUES (?,?,?,?,?)", id, userId, assetId, direction, p);
      return id;
    });
  }

  function deleteAlert(userId, alertId) {
    const r = db.run("DELETE FROM price_alerts WHERE id = ? AND user_id = ?", alertId, userId);
    if (!Number(r.changes)) throw new HttpError(404, "Không tìm thấy cảnh báo");
  }

  // ---------- Nạp / rút tiền ----------
  function createDeposit(userId, amount) {
    h.requireKyc(userId);
    const amt = h.toBig(amount, "số tiền nạp", { min: 10_000n, max: 10_000_000_000n });
    return db.tx(() => {
      const id = randomUUID();
      db.run(
        `INSERT INTO transactions (id, reference_code, user_id, type, fiat_amount, net_amount, expires_at)
         VALUES (?,?,?,'DEPOSIT',?,?, datetime('now', '+1 day'))`,
        id,
        `NAP${randomBytes(5).toString("hex").toUpperCase()}`,
        userId,
        amt,
        amt,
      );
      db.audit(userId, "DEPOSIT_REQUESTED", "transactions", id, { amt });
      return h.paymentInstructions(db.get("SELECT * FROM transactions WHERE id = ?", id));
    });
  }

  function requestWithdrawal(userId, amount) {
    h.requireKyc(userId);
    const amt = h.toBig(amount, "số tiền rút", { min: 10_000n });
    return db.tx(() => {
      const u = db.get("SELECT bank_account_number FROM users WHERE id = ?", userId);
      if (!u?.bank_account_number) throw new HttpError(409, "Chưa có tài khoản ngân hàng chính chủ");
      debitCash(userId, amt);
      // Không tự chuyển tiền: tạo bảng kê chờ Admin duyệt chi trên ngân hàng
      const batchId = h.newBatch(null, "WITHDRAWAL", [amt], userId);
      const txId = h.payoutTx({ userId, assetId: null, type: "WITHDRAWAL", gross: amt, net: amt, batchId, note: "Rút tiền về tài khoản chính chủ" });
      db.audit(userId, "WITHDRAWAL_REQUESTED", "transactions", txId, { amt, batchId });
      return { transaction_id: txId, batch_id: batchId };
    });
  }

  // ---------- Dữ liệu thị trường ----------
  function depth(assetId, levels = 10) {
    const side = (s, dir) =>
      db.all(
        `SELECT price, SUM(quantity - filled_quantity) AS qty, COUNT(*) AS orders FROM orders
          WHERE asset_id = ? AND side = ? AND status IN ('OPEN','PARTIAL') AND type <> 'MARKET'
          GROUP BY price ORDER BY price ${dir} LIMIT ?`,
        assetId,
        s,
        levels,
      );
    return { bids: side("BUY", "DESC"), asks: side("SELL", "ASC") };
  }

  function summary(asset) {
    const band = priceBand(asset);
    const dayStart = vnDayStartSql();
    const today = db.get(
      `SELECT MAX(price) AS high, MIN(price) AS low, COALESCE(SUM(quantity),0) AS volume, COALESCE(SUM(price*quantity),0) AS value, COUNT(*) AS n
         FROM trades WHERE asset_id = ? AND created_at >= ?`,
      asset.id,
      dayStart,
    );
    const lastTrade = db.get("SELECT price, quantity, created_at FROM trades WHERE asset_id = ? ORDER BY id DESC LIMIT 1", asset.id);
    const last = lastTrade?.price ?? band.ref;
    const d = depth(asset.id, 3);
    const since24h = db.get(
      "SELECT COALESCE(SUM(quantity),0) AS v FROM trades WHERE asset_id = ? AND created_at >= datetime('now','-1 day')",
      asset.id,
    ).v;
    return {
      ...band,
      last,
      last_qty: lastTrade?.quantity ?? 0n,
      last_time: lastTrade?.created_at ?? null,
      change: last - band.ref,
      change_bps: band.ref > 0n ? ((last - band.ref) * BPS) / band.ref : 0n,
      high: today.high ?? null,
      low: today.low ?? null,
      volume: today.volume,
      value: today.value,
      volume_24h: since24h,
      bids: d.bids,
      asks: d.asks,
      tick,
      market_cap: last * asset.total_tokens,
    };
  }

  const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
  function candles(assetId, interval = "1h", limit = 200) {
    const sec = INTERVALS[interval];
    if (!sec) throw new HttpError(400, "Khung thời gian không hợp lệ");
    const n = Math.min(Math.max(Number(limit) || 200, 10), 500);
    const rows = db.all(
      `SELECT price, quantity, CAST(strftime('%s', created_at) AS INTEGER) AS ts FROM trades
        WHERE asset_id = ? AND created_at >= datetime('now', ?) ORDER BY id`,
      assetId,
      `-${sec * n} seconds`,
    );
    const out = [];
    // Nến ngày căn theo giờ Việt Nam
    const shift = sec >= 86400 ? 7 * 3600 : 0;
    for (const r of rows) {
      const ts = Number(r.ts);
      const bucket = Math.floor((ts + shift) / sec) * sec - shift;
      const p = Number(r.price);
      const last = out.at(-1);
      if (last && last.t === bucket) {
        last.h = Math.max(last.h, p);
        last.l = Math.min(last.l, p);
        last.c = p;
        last.v += Number(r.quantity);
      } else {
        out.push({ t: bucket, o: last ? last.c : p, h: Math.max(p, last ? last.c : p), l: Math.min(p, last ? last.c : p), c: p, v: Number(r.quantity) });
      }
    }
    return out;
  }

  const recentTrades = (assetId, limit = 50) =>
    db.all("SELECT id, price, quantity, taker_side, created_at FROM trades WHERE asset_id = ? ORDER BY id DESC LIMIT ?", assetId, Math.min(Number(limit) || 50, 200));

  return {
    events,
    cash,
    creditCash,
    debitCash,
    referencePrice,
    priceBand,
    lastPrice,
    placeOrder,
    cancelOrder,
    cancelAllForAsset,
    createAlert,
    deleteAlert,
    createDeposit,
    requestWithdrawal,
    depth,
    summary,
    candles,
    recentTrades,
    reserveFor,
  };
}
