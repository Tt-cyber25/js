// TokenVN – SPA thuần (không framework), mobile-first.
// An toàn: mọi dữ liệu động đều đi qua esc() trước khi chèn HTML; không dùng inline script/handler (CSP).

const $app = document.getElementById("app");
const state = { token: localStorage.getItem("tvn_token"), me: null, meta: null, unread: 0, poll: null };

// ---------- tiện ích ----------
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};
const num = (v) => big(v).toLocaleString("vi-VN");
const vnd = (v) => `${num(v)} đ`;
const pct = (bps) => `${(Number(bps || 0) / 100).toLocaleString("vi-VN", { maximumFractionDigits: 2 })}%`;
const ratio = (a, b) => (big(b) === 0n ? 0 : Number((big(a) * 10000n) / big(b)) / 100);
const date = (s) => (s ? new Date(`${String(s).replace(" ", "T")}${String(s).includes("Z") ? "" : "Z"}`).toLocaleString("vi-VN") : "");

const STATUS = {
  PENDING_REVIEW: "Chờ thẩm định",
  DRAFT: "Cần bổ sung",
  FUNDING: "Đang gọi vốn",
  ACTIVE: "Đang vận hành",
  HALTED_PLANNING: "Tạm ngừng GD",
  FUNDING_FAILED: "Gọi vốn thất bại",
  DELISTED: "Đã hủy niêm yết",
};
const TX = {
  BUY_PRIMARY: "Mua sơ cấp",
  BUY_OTC: "Mua OTC",
  SELL_OTC: "Bán OTC",
  DIVIDEND: "Cổ tức",
  REFUND: "Hoàn tiền",
  EXIT_PAYOUT: "Tất toán",
  OWNER_DISBURSEMENT: "Giải ngân chủ TS",
  RENT_PAYMENT: "Tiền thuê",
};
const TXST = {
  PENDING: "Chờ thanh toán",
  COMPLETED: "Hoàn tất",
  AWAITING_PAYOUT: "Chờ chi",
  EXPIRED: "Hết hạn",
  CANCELLED: "Đã hủy",
  REFUNDED: "Đã hoàn",
  FAILED: "Lỗi",
};
const PROPOSAL = {
  VALUE_ADD_5_10_PERCENT: "Nâng giá trị (thưởng 5–10%)",
  FULL_EXIT_SALE: "Bán toàn bộ tài sản",
  BUYBACK_DELISTING: "Chủ cũ chuộc lại",
};
const PST = { VOTING: "Đang biểu quyết", APPROVED: "Đã thông qua", REJECTED: "Bị bác bỏ", EXECUTED: "Đã thực hiện" };
const pill = (s, label) => `<span class="pill st-${esc(s)}">${esc(label ?? STATUS[s] ?? s)}</span>`;

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && state.token && !path.startsWith("/api/auth")) {
    setToken(null);
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error(data?.error || `Lỗi ${res.status}`), { code: data?.code, status: res.status });
  return data;
}

function setToken(t) {
  state.token = t;
  if (t) localStorage.setItem("tvn_token", t);
  else {
    localStorage.removeItem("tvn_token");
    state.me = null;
  }
}

let toastTimer;
function toast(msg, err = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `show${err ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "";
  }, 3200);
}

const $modal = document.getElementById("modal");
function openModal(html) {
  $modal.innerHTML = `<div class="sheet">${html}</div>`;
  $modal.classList.remove("hidden");
  applyDynamic($modal);
  $modal.querySelector("input,select,textarea")?.focus();
}
function closeModal() {
  $modal.classList.add("hidden");
  $modal.innerHTML = "";
}
$modal.addEventListener("click", (e) => {
  if (e.target === $modal) closeModal();
});

// Đặt chiều rộng thanh tiến độ qua CSSOM (CSP chặn thuộc tính style inline)
function applyDynamic(root = document) {
  for (const el of root.querySelectorAll("[data-w]")) el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.w)))}%`;
  for (const el of root.querySelectorAll("[data-left]")) el.style.left = `${Number(el.dataset.left)}%`;
}

function render(html) {
  $app.innerHTML = html;
  applyDynamic($app);
  window.scrollTo(0, 0);
}

const loading = () => render('<div class="card muted">Đang tải…</div>');
const needLogin = () =>
  render(`<div class="card"><h2>Vui lòng đăng nhập</h2><p class="muted">Bạn cần đăng nhập để xem mục này.</p><a class="btn" href="#/account">Đăng nhập / Đăng ký</a></div>`);

// ---------- điều hướng ----------
function navBar() {
  const r = location.hash || "#/";
  const items = [
    ["#/", "🏛️", "Thị trường"],
    ["#/portfolio", "💼", "Danh mục"],
    ["#/notifications", "🔔", "Thông báo"],
  ];
  if (state.me && (state.me.role === "OWNER" || state.me.role === "ADMIN")) items.push(["#/list-asset", "➕", "Niêm yết"]);
  if (state.me?.role === "ADMIN") items.push(["#/admin", "🛡️", "Quản trị"]);
  items.push(["#/account", "👤", "Tài khoản"]);
  document.getElementById("bottomnav").innerHTML = items
    .map(([h, ic, l]) => {
      const active = h === "#/" ? r === "#/" || r.startsWith("#/asset") : r.startsWith(h);
      const badge = h === "#/notifications" && state.unread > 0 ? `<span class="badge">${esc(state.unread)}</span>` : "";
      return `<a href="${h}" class="${active ? "active" : ""}"><span class="ic">${ic}</span>${l}${badge}</a>`;
    })
    .join("");
  document.getElementById("topbar-right").innerHTML = state.me
    ? `<span class="pill">${esc(state.me.full_name)} · ${esc(state.me.role)}</span>`
    : `<a class="btn sm gold" href="#/account">Đăng nhập</a>`;
}

async function refreshMe() {
  if (!state.token) {
    state.me = null;
    return;
  }
  try {
    const r = await api("/api/me");
    state.me = r.user;
    state.unread = Number(r.unread);
  } catch {
    setToken(null);
  }
}

async function router() {
  clearInterval(state.poll);
  document.body.classList.remove("has-buybar");
  closeModal();
  const [pathPart, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [path, ...rest] = pathPart.split("/");
  const arg = rest.map(decodeURIComponent);
  navBar();
  try {
    if (path === "" || path === "market") await viewMarket(new URLSearchParams(qs));
    else if (path === "asset") await viewAsset(arg[0], arg[1] || "overview");
    else if (path === "pay") await viewPay(arg[0]);
    else if (path === "portfolio") await viewPortfolio();
    else if (path === "notifications") await viewNotifications();
    else if (path === "account") await viewAccount();
    else if (path === "list-asset") await viewListAsset();
    else if (path === "admin") await viewAdmin(arg[0] || "assets");
    else if (path === "cert") await viewCert(arg[0]);
    else render('<div class="card">Không tìm thấy trang.</div>');
  } catch (e) {
    render(`<div class="card notice critical">${esc(e.message)}</div>`);
  }
}

// ---------- Thị trường ----------
function assetCard(a) {
  const t = state.meta.asset_types[a.asset_type] || {};
  const sold = ratio(a.sold_tokens, a.total_tokens);
  const soft = ratio(a.min_funding_tokens, a.total_tokens);
  return `<a class="card asset-card" href="#/asset/${esc(a.id)}">
    <div class="cover t-${esc(a.asset_type)}">
      <span class="emoji">${esc(t.icon || "◆")}</span>
      <div class="row"><span class="code">${esc(a.asset_code)}</span>${pill(a.status)}</div>
    </div>
    <div class="asset-body">
      <div class="small muted">${esc(t.label)} · ${esc(a.location)}</div>
      <h3>${esc(a.title)}</h3>
      <div class="tags">${a.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}</div>
      <div class="kv"><span>Giá token</span><b>${vnd(a.last_price)}</b></div>
      <div class="kv"><span>${esc(t.incomeLabel || "Thu nhập")} / năm (ước tính)</span><b class="up">${pct(a.expected_yield_bps)}</b></div>
      <div class="kv"><span>Định giá</span><b>${vnd(a.valuation_amount)}</b></div>
      ${
        a.status === "FUNDING"
          ? `<div class="progress"><div data-w="${sold}"></div></div>
             <div class="small muted">Đã gọi vốn ${sold}% · Ngưỡng tối thiểu ${soft}%</div>`
          : ""
      }
    </div></a>`;
}

async function viewMarket(qs) {
  const type = qs.get("type") || "";
  const q = qs.get("q") || "";
  const list = await api(`/api/assets?${new URLSearchParams({ ...(type && { type }), ...(q && { q }) })}`);
  const types = Object.entries(state.meta.asset_types);
  render(`
    <section class="card">
      <h1>Số hóa & đầu tư chia nhỏ tài sản thực</h1>
      <p class="muted small">Bất động sản, bằng sáng chế, công nghệ, tài sản trí tuệ, tác phẩm sáng tạo và đồ cổ — mỗi tài sản được đặt trong một Công ty SPV,
      tiền đi thẳng vào tài khoản phong tỏa ngân hàng, sổ cái minh bạch và có lưu vết kiểm toán.</p>
      <form data-form="search" class="row"><input name="q" placeholder="Tìm theo tên, mã, địa điểm…" value="${esc(q)}" /><button class="btn">Tìm</button></form>
    </section>
    <div class="chips">
      <a class="chip ${type ? "" : "active"}" href="#/">Tất cả</a>
      ${types.map(([k, t]) => `<a class="chip ${type === k ? "active" : ""}" href="#/market?type=${k}">${t.icon} ${esc(t.label)}</a>`).join("")}
    </div>
    <div class="grid three">${list.map(assetCard).join("") || '<div class="card muted">Chưa có tài sản phù hợp.</div>'}</div>`);
}

// ---------- Chi tiết tài sản ----------
function priceChart(points) {
  if (points.length < 2) return '<p class="muted small">Chưa đủ dữ liệu giao dịch để vẽ biểu đồ giá.</p>';
  const ys = points.map((p) => Number(p.price));
  const min = Math.min(...ys) * 0.98;
  const max = Math.max(...ys) * 1.02;
  const W = 320;
  const H = 120;
  const xy = ys.map((y, i) => [(i / (ys.length - 1)) * (W - 30) + 28, H - 14 - ((y - min) / (max - min || 1)) * (H - 28)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `28,${H - 14} ${line} ${xy.at(-1)[0].toFixed(1)},${H - 14}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Biểu đồ giá token">
    <line class="axis" x1="28" y1="${H - 14}" x2="${W}" y2="${H - 14}"/>
    <polygon class="area" points="${area}"/><polyline class="line" points="${line}"/>
    <text x="0" y="12">${esc(Math.round(max).toLocaleString("vi-VN"))}</text>
    <text x="0" y="${H - 16}">${esc(Math.round(min).toLocaleString("vi-VN"))}</text>
  </svg>`;
}

function voteBlock(p, a) {
  const agree = ratio(p.tally.agree, a.total_tokens);
  const dis = ratio(p.tally.disagree, a.total_tokens);
  const thr = Number(p.approval_threshold_bps) / 100;
  const canVote = state.me && p.status === "VOTING" && !p.my_vote && a.my_holding && big(a.my_holding.available_tokens) + big(a.my_holding.locked_tokens) > 0n;
  return `<div class="card">
    <div class="row"><b>${esc(p.title)}</b> ${pill(p.status === "APPROVED" || p.status === "EXECUTED" ? "ACTIVE" : p.status === "REJECTED" ? "HALTED_PLANNING" : "FUNDING", PST[p.status])}</div>
    <div class="small muted">${esc(PROPOSAL[p.proposal_type])} · Người đề xuất: ${esc(p.proposer_name)} · Hạn: ${esc(date(p.deadline))}</div>
    ${p.description ? `<p class="small">${esc(p.description)}</p>` : ""}
    ${p.proposal_type === "VALUE_ADD_5_10_PERCENT" ? `<div class="kv"><span>Thưởng trên doanh thu tăng thêm</span><b>${pct(p.reward_bps)}</b></div><div class="kv"><span>Mức cơ sở</span><b>${vnd(p.base_income)}/tháng</b></div>` : `<div class="kv"><span>Giá đề xuất</span><b>${vnd(p.proposed_price)}${p.proposal_type === "BUYBACK_DELISTING" ? "/token" : ""}</b></div>`}
    <div class="vote-bar"><div class="bar-agree" data-w="${agree}"></div><div class="bar-disagree" data-w="${dis}"></div><div class="threshold" data-left="${thr}"></div></div>
    <div class="small muted">Đồng ý ${agree}% · Phản đối ${dis}% · Cần &gt; ${thr}% tổng token</div>
    ${p.my_vote ? `<div class="small">Bạn đã biểu quyết: <b>${p.my_vote === "AGREE" ? "Đồng ý" : "Phản đối"}</b></div>` : ""}
    ${canVote ? `<div class="row"><button class="btn sm" data-action="vote" data-id="${esc(p.id)}" data-d="AGREE">Đồng ý</button><button class="btn sm danger" data-action="vote" data-id="${esc(p.id)}" data-d="DISAGREE">Phản đối</button></div>` : ""}
  </div>`;
}

let currentAsset = null;
async function viewAsset(id, tab) {
  const a = await api(`/api/assets/${encodeURIComponent(id)}`);
  currentAsset = a;
  const t = a.type_def;
  const h = a.my_holding;
  const mine = h ? big(h.available_tokens) + big(h.locked_tokens) : 0n;
  const remaining = big(a.total_tokens) - big(a.sold_tokens) - big(a.reserved_tokens);
  const tabs = [
    ["overview", "Tổng quan & Dòng tiền"],
    ["legal", "Pháp lý & Hồ sơ"],
    ["governance", "Quản trị & Đề xuất"],
    ["market", "Giao dịch OTC"],
  ];
  let body = "";
  if (tab === "overview") {
    body = `
      <div class="card"><h3>Giá token</h3><div class="big">${vnd(a.last_price)}</div>
        <div class="small ${big(a.last_price) >= big(a.token_price) ? "up" : "down"}">Mệnh giá gốc ${vnd(a.token_price)} · ${ratio(big(a.last_price) - big(a.token_price), a.token_price)}%</div>
        ${priceChart(a.price_history)}</div>
      <div class="grid">
        <div class="card">
          <div class="kv"><span>Định giá</span><b>${vnd(a.valuation_amount)}</b></div>
          <div class="kv"><span>Tổng số token</span><b>${num(a.total_tokens)}</b></div>
          <div class="kv"><span>Đã bán sơ cấp</span><b>${num(a.sold_tokens)} (${ratio(a.sold_tokens, a.total_tokens)}%)</b></div>
          <div class="kv"><span>Ngưỡng gọi vốn tối thiểu</span><b>${num(a.min_funding_tokens)} token</b></div>
          <div class="kv"><span>${esc(t.incomeLabel)} cam kết</span><b>${vnd(a.monthly_rent_commitment)}/tháng</b></div>
          <div class="kv"><span>Tỷ suất ước tính/năm</span><b class="up">${pct(a.expected_yield_bps)}</b></div>
          ${Number(a.is_sale_leaseback) ? `<div class="kv"><span>Quỹ dự phòng thuê (6 tháng)</span><b>${vnd(a.rent_escrow_balance)}</b></div>` : ""}
          <div class="kv"><span>Số cổ đông</span><b>${esc(a.holder_count)}</b></div>
        </div>
        <div class="card"><h3>Giới thiệu</h3><p>${esc(a.description) || '<span class="muted">—</span>'}</p>
          ${
            mine > 0n
              ? `<div class="notice info">Bạn đang nắm <b>${num(mine)}</b> token (${ratio(mine, a.total_tokens)}%)${big(h.locked_tokens) > 0n ? ` · ${num(h.locked_tokens)} đang khóa` : ""}.</div>
                 <div class="row"><a class="btn sm ghost" href="#/cert/${esc(a.id)}">Giấy xác nhận sở hữu</a>${a.status === "ACTIVE" ? `<button class="btn sm" data-action="sell" data-asset="${esc(a.id)}" data-max="${esc(h.available_tokens)}" data-price="${esc(a.last_price)}">Đặt bán OTC</button>` : ""}</div>`
              : ""
          }
        </div>
      </div>
      <div class="card"><h3>Báo cáo thu nhập & cổ tức (P&L)</h3>
        ${
          a.income_reports.length
            ? `<div class="table-wrap"><table><tr><th>Kỳ</th><th class="num">Doanh thu</th><th class="num">Phí QL</th><th class="num">Thưởng VH</th><th class="num">Thuế TNCN</th><th class="num">Thực chi</th></tr>
              ${a.income_reports.map((r) => `<tr><td>${esc(r.period)}</td><td class="num">${num(r.gross_amount)}</td><td class="num">${num(r.platform_fee)}</td><td class="num">${num(r.operator_reward)}</td><td class="num">${num(r.tax_total)}</td><td class="num">${num(r.net_paid)}</td></tr>`).join("")}</table></div>`
            : '<p class="muted small">Chưa có kỳ chia cổ tức.</p>'
        }</div>`;
  } else if (tab === "legal") {
    body = `
      <div class="card"><h3>Thông tin ${esc(t.label.toLowerCase())}</h3>
        ${t.fields.map((f) => `<div class="kv"><span>${esc(f.label)}</span><b>${esc(a.metadata[f.key] ?? "—")}</b></div>`).join("")}</div>
      <div class="card"><h3>Pháp nhân nắm giữ (SPV) & lưu ký</h3>
        ${
          a.spv
            ? `<div class="kv"><span>Công ty SPV</span><b>${esc(a.spv.company_name)}</b></div>
               <div class="kv"><span>Mã số thuế</span><b>${esc(a.spv.tax_code)}</b></div>
               <div class="kv"><span>Ngân hàng lưu ký</span><b>${esc(a.spv.bank_custodian_name)}</b></div>
               ${a.spv.custody_certificate_url ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="${esc(a.spv.custody_certificate_url)}">Xem chứng thư lưu ký</a>` : ""}`
            : '<p class="muted">Chưa gán SPV (đang thẩm định).</p>'
        }</div>
      <div class="card"><h3>Hồ sơ pháp lý (đã che thông tin nhạy cảm)</h3>
        ${a.documents.map((d) => `<div class="kv"><span>📄 ${esc(d.title)}</span><b>${d.url ? `<a target="_blank" rel="noopener" href="${esc(d.url)}">Xem</a>` : "—"}</b></div>${d.sha256 ? `<div class="mono muted">SHA-256: ${esc(d.sha256)}</div>` : ""}`).join("") || '<p class="muted">Chưa có hồ sơ.</p>'}
        <p class="small muted">Bộ hồ sơ bắt buộc cho loại tài sản này: ${t.requiredDocs.map(esc).join(" · ")}</p></div>`;
  } else if (tab === "governance") {
    const operators = a.proposals.filter((p) => p.proposal_type === "VALUE_ADD_5_10_PERCENT" && p.status === "APPROVED");
    body = `
      <div class="notice info">Quyết định bán toàn bộ/chuộc lại cần <b>&gt; 75%</b> tổng token đồng ý. Chủ cũ nắm &gt; 90% có quyền kéo theo (Drag-Along) nhưng phải bảo vệ mệnh giá gốc cho cổ đông nhỏ khi bán lỗ. Token đã dùng để biểu quyết bị khóa chuyển nhượng tới khi kết thúc biểu quyết.</div>
      <div class="card"><h3>Cổ đông đang vận hành nâng giá trị</h3>
        ${operators.map((p) => `<div class="kv"><span>${esc(p.proposer_name)} – ${esc(p.title)}</span><b>${pct(p.reward_bps)}</b></div>`).join("") || '<p class="muted small">Chưa có.</p>'}</div>
      ${a.proposals.map((p) => voteBlock(p, a)).join("") || '<div class="card muted">Chưa có đề xuất.</div>'}
      ${
        mine > 0n && a.status === "ACTIVE"
          ? `<div class="card"><h3>Tạo đề xuất mới</h3><form data-form="proposal">
              <div class="field"><label>Loại đề xuất</label><select name="proposal_type">
                <option value="VALUE_ADD_5_10_PERCENT">${PROPOSAL.VALUE_ADD_5_10_PERCENT}</option>
                <option value="FULL_EXIT_SALE">${PROPOSAL.FULL_EXIT_SALE}</option>
                ${a.owner_id === state.me?.id ? `<option value="BUYBACK_DELISTING">${PROPOSAL.BUYBACK_DELISTING}</option>` : ""}
              </select></div>
              <div class="field"><label>Tiêu đề</label><input name="title" required maxlength="200" /></div>
              <div class="field"><label>Mô tả kế hoạch</label><textarea name="description" maxlength="5000"></textarea></div>
              <div class="field"><label>Tỷ lệ thưởng (%) – chỉ cho đề xuất nâng giá trị, 5–10</label><input name="reward_pct" type="number" min="5" max="10" step="0.5" value="8" /></div>
              <div class="field"><label>Giá đề xuất (VND – tổng giá bán, hoặc giá/token với chuộc lại)</label><input name="proposed_price" type="number" min="1" step="1" /></div>
              <div class="field"><label>Số ngày biểu quyết</label><input name="voting_days" type="number" min="1" max="60" value="14" /></div>
              <button class="btn">Gửi đề xuất</button></form></div>`
          : ""
      }`;
  } else if (tab === "market") {
    body = `
      <div class="card"><h3>Sổ lệnh bán OTC</h3>
        ${a.status !== "ACTIVE" ? `<div class="notice">Giao dịch thứ cấp chỉ mở khi tài sản ở trạng thái “Đang vận hành”.</div>` : ""}
        ${
          a.listings.length
            ? `<table><tr><th class="num">Giá/token</th><th class="num">Khả dụng</th><th></th></tr>
              ${a.listings.map((l) => `<tr><td class="num">${vnd(l.price_per_token)}</td><td class="num">${num(l.available)}</td><td class="num">${Number(l.mine) ? '<span class="muted small">Lệnh của bạn</span>' : `<button class="btn sm" data-action="buy-otc" data-id="${esc(l.id)}" data-max="${esc(l.available)}" data-price="${esc(l.price_per_token)}">Mua</button>`}</td></tr>`).join("")}</table>`
            : '<p class="muted small">Chưa có lệnh bán.</p>'
        }
        <p class="small muted">Phí giao dịch OTC ${pct(state.meta.fees.otc_fee_bps)} (trừ vào tiền bên bán). Tiền mua đi thẳng vào tài khoản phong tỏa; token chỉ chuyển khi ngân hàng xác nhận.</p>
      </div>`;
  }

  let buybar = "";
  if (a.status === "FUNDING") {
    buybar = `<div class="buybar"><div><div class="small muted">Giá suất</div><div class="price">${vnd(a.token_price)}</div><div class="small muted">Còn ${num(remaining)} token</div></div>
      <button class="btn gold" data-action="buy-primary" ${remaining > 0n ? "" : "disabled"}>Mua suất đầu tư</button></div>`;
  } else if (a.status === "ACTIVE") {
    buybar = `<div class="buybar"><div><div class="small muted">Giá gần nhất</div><div class="price">${vnd(a.last_price)}</div></div>
      <a class="btn gold" href="#/asset/${esc(a.id)}/market">Giao dịch OTC</a></div>`;
  }
  if (buybar) document.body.classList.add("has-buybar");

  render(`
    <div class="card asset-card"><div class="cover t-${esc(a.asset_type)}"><span class="emoji">${esc(t.icon)}</span><div class="row"><span class="code">${esc(a.asset_code)}</span>${pill(a.status)}</div></div>
      <div class="asset-body"><div class="small muted">${esc(t.label)} · ${esc(a.location)} · Chủ tài sản: ${esc(a.owner_name)}</div><h1>${esc(a.title)}</h1>
      <div class="tags">${a.tags.map((x) => `<span class="tag">${esc(x)}</span>`).join("")}${Number(a.is_sale_leaseback) ? '<span class="tag">Bán & Thuê lại</span>' : ""}</div></div></div>
    ${a.status === "HALTED_PLANNING" ? `<div class="notice critical"><b>TẠM NGỪNG GIAO DỊCH:</b> ${esc(t.haltLabel)}. Mọi giao dịch thứ cấp bị khóa. ${a.halt_notice_url ? `<a target="_blank" rel="noopener" href="${esc(a.halt_notice_url)}">Xem văn bản chính thức</a>` : ""}</div>` : ""}
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? "active" : ""}" href="#/asset/${esc(a.id)}/${k}">${l}</a>`).join("")}</div>
    ${body}${buybar}`);
}

function qtyModal({ title, max, price, action, extra = "" }) {
  openModal(`<h2>${esc(title)}</h2>
    <form data-form="${action}">${extra}
      <div class="field"><label>Số lượng token (tối đa ${num(max)})</label><input name="qty" type="number" min="1" max="${esc(max)}" step="1" value="${big(max) < 100n ? esc(max) : "100"}" required data-price="${esc(price)}" /></div>
      <div class="kv"><span>Đơn giá</span><b>${vnd(price)}</b></div>
      <div class="kv"><span>Thành tiền</span><b id="qty-total">—</b></div>
      <p class="small muted">Sau khi xác nhận, hệ thống cấp mã VietQR định danh. Tiền chuyển thẳng vào tài khoản phong tỏa tại ngân hàng đối tác — nền tảng không giữ tiền hộ.</p>
      <div class="row"><button class="btn gold">Xác nhận & lấy mã QR</button><button type="button" class="btn ghost" data-action="close">Hủy</button></div>
    </form>`);
  const input = $modal.querySelector('input[name="qty"]');
  const upd = () => {
    document.getElementById("qty-total").textContent = /^\d+$/.test(input.value) ? vnd(big(input.value) * big(price)) : "—";
  };
  input.addEventListener("input", upd);
  upd();
}

// ---------- Thanh toán ----------
async function viewPay(txId) {
  if (!state.me) return needLogin();
  const draw = async () => {
    const o = await api(`/api/orders/${encodeURIComponent(txId)}`);
    const p = o.payment;
    render(`<div class="card">
      <h1>${o.status === "COMPLETED" ? "✅ Thanh toán thành công" : o.status === "PENDING" ? "Quét mã để thanh toán" : `Đơn ${esc(TXST[o.status] || o.status)}`}</h1>
      <div class="small muted">${esc(TX[o.type])} · ${esc(o.asset.asset_code)} – ${esc(o.asset.title)}</div>
      <div class="kv"><span>Số token</span><b>${num(o.token_amount)}</b></div>
      <div class="kv"><span>Số tiền</span><b>${vnd(o.fiat_amount)}</b></div>
      ${
        p
          ? `<img class="qr" alt="Mã VietQR" src="${esc(p.qr_url)}" />
             <div class="kv"><span>Ngân hàng (BIN)</span><b>${esc(p.bank_id)}</b></div>
             <div class="kv"><span>Số tài khoản phong tỏa</span><b>${esc(p.account_no)}</b></div>
             <div class="kv"><span>Chủ tài khoản</span><b>${esc(p.account_name)}</b></div>
             <div class="kv"><span>Nội dung chuyển khoản</span><b class="mono">${esc(p.reference_code)}</b></div>
             <div class="kv"><span>Hết hạn giữ chỗ</span><b>${esc(date(p.expires_at))}</b></div>
             <div class="notice">Ghi <b>chính xác</b> nội dung chuyển khoản và số tiền. Hệ thống tự động xác nhận khi ngân hàng báo có.</div>
             <div class="row">
               ${state.meta.allow_bank_simulator ? `<button class="btn" data-action="simulate" data-id="${esc(o.id)}">🧪 Mô phỏng ngân hàng báo có (demo)</button>` : ""}
               <button class="btn ghost" data-action="cancel-order" data-id="${esc(o.id)}">Hủy đơn</button></div>`
          : `<p>${o.status === "COMPLETED" ? (o.type === "BUY_PRIMARY" ? "Token đã ghi nhận vào danh mục ở trạng thái <b>chờ hoàn tất gọi vốn</b>; sẽ mở khóa khi tài sản sang tên SPV." : "Token đã chuyển vào danh mục của bạn.") : ""}</p>`
      }
      <div class="row"><a class="btn ghost" href="#/asset/${esc(o.asset.id)}">Về tài sản</a><a class="btn ghost" href="#/portfolio">Danh mục</a></div></div>`);
    const qr = $app.querySelector("img.qr");
    qr?.addEventListener("error", () => {
      qr.replaceWith(Object.assign(document.createElement("div"), {
        className: "notice",
        textContent: "Không tải được ảnh VietQR — vui lòng chuyển khoản thủ công theo thông tin bên dưới.",
      }));
    });
    if (o.status !== "PENDING") clearInterval(state.poll);
  };
  await draw();
  state.poll = setInterval(() => draw().catch(() => {}), 4000);
}

// ---------- Danh mục ----------
async function viewPortfolio() {
  if (!state.me) return needLogin();
  const p = await api("/api/portfolio");
  render(`
    <div class="card"><div class="small muted">Tổng tài sản ròng (theo giá gần nhất)</div><div class="big">${vnd(p.net_worth)}</div>
      <div class="small">Cổ tức đã nhận (sau thuế): <b class="up">${vnd(p.dividends_total)}</b></div></div>
    <h2>Tài sản đang nắm giữ</h2>
    ${
      p.holdings
        .map((h) => {
          const qty = big(h.available_tokens) + big(h.locked_tokens);
          const pnl = big(h.market_value) - big(h.cost_basis);
          return `<div class="card"><div class="row"><a href="#/asset/${esc(h.asset_id)}"><b>${esc(h.asset_code)}</b></a>${pill(h.status)}</div>
            <div class="small">${esc(h.title)}</div>
            <div class="kv"><span>Số token</span><b>${num(qty)}${big(h.locked_tokens) > 0n ? ` (khóa ${num(h.locked_tokens)})` : ""}</b></div>
            <div class="kv"><span>Giá vốn TB / Giá hiện tại</span><b>${vnd(h.avg_buy_price)} / ${vnd(h.last_price)}</b></div>
            <div class="kv"><span>Giá trị</span><b>${vnd(h.market_value)}</b></div>
            <div class="kv"><span>Lãi/lỗ tạm tính</span><b class="${pnl >= 0n ? "up" : "down"}">${vnd(pnl)}</b></div>
            <div class="row"><a class="btn sm ghost" href="#/cert/${esc(h.asset_id)}">📄 Giấy xác nhận sở hữu</a>
            ${h.status === "ACTIVE" && big(h.available_tokens) > 0n ? `<button class="btn sm" data-action="sell" data-asset="${esc(h.asset_id)}" data-max="${esc(h.available_tokens)}" data-price="${esc(h.last_price)}">Đặt bán OTC</button>` : ""}</div></div>`;
        })
        .join("") || '<div class="card muted">Bạn chưa sở hữu tài sản nào. <a href="#/">Khám phá thị trường</a></div>'
    }
    ${
      p.listings.length
        ? `<h2>Lệnh bán đang mở</h2><div class="card"><table><tr><th>Tài sản</th><th class="num">Còn lại</th><th class="num">Giá</th><th></th></tr>
          ${p.listings.map((l) => `<tr><td>${esc(l.asset_code)}</td><td class="num">${num(l.remaining_tokens)}</td><td class="num">${vnd(l.price_per_token)}</td><td class="num"><button class="btn sm ghost" data-action="cancel-listing" data-id="${esc(l.id)}">Hủy</button></td></tr>`).join("")}</table></div>`
        : ""
    }
    <h2>Lịch sử giao dịch & cổ tức</h2>
    <div class="card table-wrap"><table><tr><th>Thời gian</th><th>Loại</th><th>TS</th><th class="num">Token</th><th class="num">Thực nhận/chi</th><th>Trạng thái</th></tr>
      ${p.transactions.map((t) => `<tr><td class="small">${esc(date(t.created_at))}</td><td>${esc(TX[t.type] || t.type)}${t.tax_amount !== "0" ? `<div class="small muted">Thuế ${num(t.tax_amount)}</div>` : ""}</td><td>${esc(t.asset_code)}</td><td class="num">${num(t.token_amount)}</td><td class="num">${num(t.net_amount)}</td><td>${t.status === "PENDING" ? `<a href="#/pay/${esc(t.id)}">${esc(TXST[t.status])}</a>` : esc(TXST[t.status] || t.status)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Chưa có giao dịch.</td></tr>'}
    </table></div>`);
}

async function viewCert(assetId) {
  if (!state.me) return needLogin();
  const c = await api(`/api/certificates/${encodeURIComponent(assetId)}`);
  render(`<div class="card cert">
    <h1>GIẤY XÁC NHẬN SỞ HỮU PHẦN VỐN GÓP / TOKEN</h1>
    <p class="muted small">Số: <span class="mono">${esc(c.certificate_no)}</span> · Lập lúc ${esc(date(c.issued_at))}</p>
    <div class="kv"><span>Người sở hữu</span><b>${esc(c.holder.full_name)}</b></div>
    <div class="kv"><span>CCCD</span><b>${esc(c.holder.cccd_masked || "—")}</b></div>
    <div class="kv"><span>Tài sản</span><b>${esc(c.asset.code)} – ${esc(c.asset.title)}</b></div>
    <div class="kv"><span>Loại tài sản</span><b>${esc(c.asset.type)}</b></div>
    ${c.spv ? `<div class="kv"><span>Pháp nhân nắm giữ (SPV)</span><b>${esc(c.spv.company_name)} – MST ${esc(c.spv.tax_code)}</b></div><div class="kv"><span>Ngân hàng lưu ký</span><b>${esc(c.spv.custodian)}</b></div>` : ""}
    <div class="kv"><span>Số token sở hữu</span><b>${num(c.tokens)} / ${num(c.asset.total_tokens)}</b></div>
    <div class="kv"><span>Tỷ lệ sở hữu</span><b>${pct(c.ownership_bps)}</b></div>
    <div class="seal"><div class="small muted">Dấu niêm phong số (SHA-256 nội dung xác nhận)</div><div class="mono">${esc(c.seal)}</div>
      <div class="small muted">Gắn với đỉnh chuỗi nhật ký kiểm toán: <span class="mono">${esc(c.audit_head || "—")}</span></div></div>
    <p class="small muted">Giấy xác nhận được trích xuất từ sổ cái phụ của nền tảng. Giá trị pháp lý của quyền sở hữu căn cứ vào Hợp đồng góp vốn/chuyển nhượng phần vốn góp đã ký số và Sổ đăng ký thành viên/cổ đông của SPV.</p>
  </div>
  <div class="row no-print"><button class="btn" data-action="print">🖨️ In / Lưu PDF</button><a class="btn ghost" href="#/portfolio">Quay lại</a></div>`);
}

// ---------- Thông báo ----------
async function viewNotifications() {
  if (!state.me) return needLogin();
  const list = await api("/api/notifications");
  render(`<h2>Thông báo</h2>${
    list.map((n) => `<div class="card notif ${esc(n.severity)} ${Number(n.is_read) ? "" : "unread"}"><b>${esc(n.title)}</b><div>${esc(n.body)}</div><div class="small muted">${esc(date(n.created_at))}</div></div>`).join("") ||
    '<div class="card muted">Không có thông báo.</div>'
  }`);
  if (state.unread > 0) {
    await api("/api/notifications/read", { method: "POST", body: {} });
    state.unread = 0;
    navBar();
  }
}

// ---------- Tài khoản ----------
async function viewAccount() {
  if (!state.me) {
    render(`
      <div class="grid">
        <div class="card"><h2>Đăng nhập</h2><form data-form="login">
          <div class="field"><label>Email</label><input name="email" type="email" required autocomplete="username" /></div>
          <div class="field"><label>Mật khẩu</label><input name="password" type="password" required autocomplete="current-password" /></div>
          <button class="btn block">Đăng nhập</button></form>
          <div class="notice info small">Tài khoản demo (mật khẩu <b>Demo@12345</b>): admin@demo.vn · owner@demo.vn · owner2@demo.vn · investor@demo.vn · investor2@demo.vn · investor3@demo.vn</div></div>
        <div class="card"><h2>Đăng ký</h2><form data-form="register">
          <div class="field"><label>Họ và tên</label><input name="full_name" required maxlength="120" /></div>
          <div class="field"><label>Email</label><input name="email" type="email" required /></div>
          <div class="field"><label>Số điện thoại</label><input name="phone" maxlength="20" /></div>
          <div class="field"><label>Mật khẩu (≥ 8 ký tự)</label><input name="password" type="password" minlength="8" required autocomplete="new-password" /></div>
          <div class="field"><label>Vai trò</label><select name="role"><option value="INVESTOR">Nhà đầu tư</option><option value="OWNER">Chủ tài sản (muốn niêm yết)</option></select></div>
          <button class="btn block gold">Tạo tài khoản</button></form></div>
      </div>`);
    return;
  }
  const u = state.me;
  const mine = u.role !== "INVESTOR" ? await api("/api/my-assets") : [];
  render(`
    <div class="card"><h2>${esc(u.full_name)}</h2>
      <div class="kv"><span>Email</span><b>${esc(u.email)}</b></div>
      <div class="kv"><span>Vai trò</span><b>${esc(u.role)}</b></div>
      <div class="kv"><span>eKYC</span><b>${pill(u.kyc_status === "VERIFIED" ? "ACTIVE" : u.kyc_status === "REJECTED" ? "HALTED_PLANNING" : "PENDING_REVIEW", { UNSUBMITTED: "Chưa xác thực", PENDING: "Đang duyệt", VERIFIED: "Đã xác thực", REJECTED: "Bị từ chối" }[u.kyc_status])}</b></div>
      ${u.cccd_masked ? `<div class="kv"><span>CCCD</span><b>${esc(u.cccd_masked)}</b></div>` : ""}
      ${u.bank_account_masked ? `<div class="kv"><span>Tài khoản nhận tiền</span><b>${esc(u.bank_name)} ${esc(u.bank_account_masked)}</b></div>` : ""}
      <button class="btn ghost sm" data-action="logout">Đăng xuất</button></div>
    ${
      u.kyc_status === "UNSUBMITTED" || u.kyc_status === "REJECTED"
        ? `<div class="card"><h3>Xác thực danh tính (eKYC)</h3>
            <p class="small muted">Bắt buộc trước khi đầu tư hoặc niêm yết. Bản demo nhập tay; bản vận hành tích hợp eKYC bên thứ ba (OCR CCCD + so khớp khuôn mặt).</p>
            <form data-form="kyc">
              <div class="field"><label>Số CCCD (12 số)</label><input name="cccd_number" pattern="\\d{12}" required /></div>
              <div class="field"><label>Ngân hàng nhận cổ tức</label><input name="bank_name" required /></div>
              <div class="field"><label>Số tài khoản (chính chủ)</label><input name="bank_account_number" required /></div>
              <button class="btn">Gửi hồ sơ</button></form></div>`
        : ""
    }
    ${
      mine.length
        ? `<div class="card"><h3>Tài sản tôi niêm yết</h3>${mine.map((a) => `<div class="kv"><span><a href="#/asset/${esc(a.id)}">${esc(a.asset_code)}</a> ${esc(a.title)}</span><b>${pill(a.status)}</b></div>`).join("")}</div>`
        : ""
    }`);
}

// ---------- Niêm yết tài sản ----------
function typeFields(type) {
  const t = state.meta.asset_types[type];
  return `${t.fields.map((f) => `<div class="field"><label>${esc(f.label)}</label><input name="m_${esc(f.key)}" type="${f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}" /></div>`).join("")}
    <h3>Hồ sơ pháp lý</h3><p class="small muted">Tải bản scan đã che thông tin lên kho lưu trữ của bạn và dán đường dẫn. Mã SHA-256 (tùy chọn) giúp nhà đầu tư đối chiếu bản gốc.</p>
    ${t.requiredDocs.map((d, i) => `<div class="field"><label>${esc(d)}</label><input name="doc_url_${i}" placeholder="https://…" /><input name="doc_sha_${i}" placeholder="SHA-256 (tùy chọn)" /><input type="hidden" name="doc_title_${i}" value="${esc(d)}" /></div>`).join("")}`;
}

async function viewListAsset() {
  if (!state.me) return needLogin();
  if (state.me.role === "INVESTOR") return render('<div class="card">Chỉ tài khoản Chủ tài sản mới được niêm yết.</div>');
  const types = Object.entries(state.meta.asset_types);
  render(`<div class="card"><h1>Niêm yết tài sản mới</h1>
    ${state.me.kyc_status !== "VERIFIED" ? '<div class="notice">Bạn cần hoàn tất eKYC trước khi gửi hồ sơ.</div>' : ""}
    <form data-form="list-asset">
      <div class="field"><label>Loại tài sản</label><select name="asset_type" id="asset-type">${types.map(([k, t]) => `<option value="${k}">${t.icon} ${esc(t.label)}</option>`).join("")}</select></div>
      <div class="field"><label>Tên tài sản</label><input name="title" required maxlength="200" /></div>
      <div class="field"><label>Mô tả</label><textarea name="description" maxlength="5000"></textarea></div>
      <div class="field"><label>Vị trí / nơi lưu giữ</label><input name="location" maxlength="300" /></div>
      <div class="grid">
        <div class="field"><label>Giá trị định giá đề xuất (VND)</label><input name="valuation_amount" type="number" min="1000000" step="10000" required /></div>
        <div class="field"><label>Giá mỗi token (VND)</label><input name="token_price" type="number" min="1000" step="1000" value="10000" required /></div>
        <div class="field"><label>Ngưỡng gọi vốn tối thiểu (%)</label><input name="soft_cap_pct" type="number" min="1" max="100" value="50" required /></div>
        <div class="field"><label>Thu nhập cam kết hàng tháng (VND)</label><input name="monthly_rent_commitment" type="number" min="0" step="1000" value="0" /></div>
      </div>
      <div class="field"><label class="checkbox"><input type="checkbox" name="is_sale_leaseback" /> Bán & thuê lại (giữ quỹ dự phòng 6 tháng thu nhập cam kết)</label></div>
      <div class="field"><label>Nhãn nổi bật (phân tách bằng dấu phẩy)</label><input name="tags" placeholder="vd: Đất sạch 0% nợ, Văn bằng còn hiệu lực 10 năm" /></div>
      <div id="type-fields">${typeFields(types[0][0])}</div>
      <button class="btn gold block">Gửi hồ sơ thẩm định</button>
    </form></div>`);
  document.getElementById("asset-type").addEventListener("change", (e) => {
    document.getElementById("type-fields").innerHTML = typeFields(e.target.value);
  });
}

// ---------- Quản trị ----------
async function viewAdmin(tab) {
  if (state.me?.role !== "ADMIN") return render('<div class="card">Không có quyền truy cập.</div>');
  const o = await api("/api/admin/overview");
  window.__spvs = o.spvs;
  const tabs = [
    ["assets", "Tài sản"],
    ["kyc", `eKYC (${o.pending_kyc.length})`],
    ["batches", "Bảng kê chi"],
    ["spv", "SPV"],
    ["audit", "Nhật ký kiểm toán"],
  ];
  let body = "";
  if (tab === "assets") {
    const actions = (a) => {
      const b = (act, label, cls = "ghost") => `<button class="btn sm ${cls}" data-action="${act}" data-id="${esc(a.id)}">${label}</button>`;
      if (a.status === "PENDING_REVIEW") return b("adm-approve", "Duyệt niêm yết", "") + b("adm-reject", "Yêu cầu bổ sung");
      if (a.status === "FUNDING") return b("adm-activate", "Hoàn tất gọi vốn", "") + b("adm-fail", "Hủy & hoàn tiền", "danger") + b("adm-halt", "Tạm ngừng");
      if (a.status === "ACTIVE") return b("adm-rent", "Chia cổ tức", "") + b("adm-halt", "Tạm ngừng", "danger") + b("adm-exit", "Tất toán / Thoái vốn");
      if (a.status === "HALTED_PLANNING") return b("adm-resume", "Mở lại GD", "") + b("adm-rent", "Chia cổ tức") + b("adm-exit", "Tất toán / Bồi thường");
      return "";
    };
    body = `
      ${o.proposals.length ? `<div class="card"><h3>Đề xuất đã thông qua chờ thực hiện</h3>${o.proposals.map((p) => `<div class="kv"><span>${esc(p.asset_code)} · ${esc(PROPOSAL[p.proposal_type])} · ${vnd(p.proposed_price)}</span><b>${p.proposal_type === "BUYBACK_DELISTING" ? `<button class="btn sm" data-action="adm-buyback" data-id="${esc(p.id)}">Thực hiện chuộc lại</button>` : `<button class="btn sm" data-action="adm-exit" data-id="${esc(p.asset_id)}">Tất toán</button>`}</b></div>`).join("")}</div>` : ""}
      ${o.assets
        .map(
          (a) => `<div class="card"><div class="row"><a href="#/asset/${esc(a.id)}"><b>${esc(a.asset_code)}</b></a>${pill(a.status)}<span class="small muted">${esc(a.type_label)}</span></div>
          <div class="small">${esc(a.title)}</div>
          <div class="small muted">Định giá ${vnd(a.valuation_amount)} · Đã bán ${num(a.sold_tokens)}/${num(a.total_tokens)} · Soft cap ${num(a.min_funding_tokens)}${Number(a.is_sale_leaseback) ? ` · Quỹ dự phòng ${vnd(a.rent_escrow_balance)}` : ""}</div>
          <div class="row">${actions(a)}</div></div>`,
        )
        .join("")}`;
  } else if (tab === "kyc") {
    body =
      o.pending_kyc
        .map((u) => `<div class="card"><b>${esc(u.full_name)}</b> <span class="small muted">${esc(u.email)}</span>
          <div class="kv"><span>CCCD</span><b>${esc(u.cccd_number)}</b></div><div class="kv"><span>Ngân hàng</span><b>${esc(u.bank_name)} ${esc(u.bank_account_masked)}</b></div>
          <div class="row"><button class="btn sm" data-action="adm-kyc" data-id="${esc(u.id)}" data-ok="1">Duyệt</button><button class="btn sm danger" data-action="adm-kyc" data-id="${esc(u.id)}" data-ok="0">Từ chối</button></div></div>`)
        .join("") || '<div class="card muted">Không có hồ sơ chờ duyệt.</div>';
  } else if (tab === "batches") {
    body = `<div class="notice">Hệ thống <b>không tự chuyển tiền</b>. Tải bảng kê CSV, duyệt chi thủ công trên ứng dụng ngân hàng, rồi bấm “Xác nhận đã chi”.</div>
      <div class="card table-wrap"><table><tr><th>Ngày</th><th>TS</th><th>Loại</th><th class="num">Số dòng</th><th class="num">Tổng tiền</th><th>Trạng thái</th><th></th></tr>
      ${o.batches.map((b) => `<tr><td class="small">${esc(date(b.created_at))}</td><td>${esc(b.asset_code)}</td><td>${esc(b.kind)}</td><td class="num">${num(b.line_count)}</td><td class="num">${num(b.total_amount)}</td><td>${b.status === "PAID" ? pill("ACTIVE", "Đã chi") : pill("PENDING_REVIEW", "Chờ duyệt")}</td>
        <td class="num"><button class="btn sm ghost" data-action="adm-csv" data-id="${esc(b.id)}">CSV</button>${b.status !== "PAID" ? ` <button class="btn sm" data-action="adm-paid" data-id="${esc(b.id)}">Xác nhận đã chi</button>` : ""}</td></tr>`).join("")}</table></div>`;
  } else if (tab === "spv") {
    body = `${o.spvs.map((s) => `<div class="card"><b>${esc(s.company_name)}</b><div class="small muted">MST ${esc(s.tax_code)} · Lưu ký: ${esc(s.bank_custodian_name)}</div></div>`).join("")}
      <div class="card"><h3>Thêm SPV</h3><form data-form="spv">
        <div class="field"><label>Tên công ty</label><input name="company_name" required /></div>
        <div class="field"><label>Mã số thuế</label><input name="tax_code" required /></div>
        <div class="field"><label>Ngân hàng lưu ký</label><input name="bank_custodian_name" required /></div>
        <div class="field"><label>URL chứng thư lưu ký</label><input name="custody_certificate_url" /></div>
        <button class="btn">Tạo SPV</button></form></div>`;
  } else if (tab === "audit") {
    const au = await api("/api/admin/audit");
    body = `<div class="notice ${au.chain.ok ? "info" : "critical"}">Chuỗi băm nhật ký: <b>${au.chain.ok ? "TOÀN VẸN" : `BỊ PHÁ VỠ tại #${esc(au.chain.brokenAt)}`}</b>. Bảng nhật ký chặn UPDATE/DELETE ở tầng cơ sở dữ liệu.</div>
      <div class="card table-wrap"><table><tr><th>#</th><th>Thời gian</th><th>Hành động</th><th>Đối tượng</th><th>Dữ liệu</th></tr>
      ${au.logs.map((l) => `<tr><td>${esc(l.seq)}</td><td class="small">${esc(date(l.created_at))}</td><td>${esc(l.action)}</td><td class="small">${esc(l.entity)}</td><td class="mono">${esc(l.data_json)}</td></tr>`).join("")}</table></div>`;
  }
  render(`<div class="grid three">
      <div class="card"><div class="small muted">Người dùng</div><div class="big">${num(o.stats.users)}</div></div>
      <div class="card"><div class="small muted">Tiền vào tài khoản phong tỏa</div><div class="big">${vnd(o.stats.escrow_inflow)}</div></div>
      <div class="card"><div class="small muted">Chờ duyệt chi</div><div class="big">${vnd(o.stats.pending_payout)}</div></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? "active" : ""}" href="#/admin/${k}">${l}</a>`).join("")}</div>${body}`);
}

function previewTable(lines, amountKey = "amount") {
  return `<div class="table-wrap"><table><tr><th>Cổ đông</th><th class="num">Token</th>${amountKey === "net" ? '<th class="num">Gộp</th><th class="num">Thuế</th>' : ""}<th class="num">Nhận</th></tr>
    ${lines.map((l) => `<tr><td>${esc(l.full_name || l.user_id)}</td><td class="num">${num(l.tokens)}</td>${amountKey === "net" ? `<td class="num">${num(l.gross)}</td><td class="num">${num(l.tax)}</td>` : ""}<td class="num">${num(l[amountKey])}</td></tr>`).join("")}</table></div>`;
}

// ---------- xử lý sự kiện ----------
const forms = {
  search(f) {
    const q = f.q.value.trim();
    const type = new URLSearchParams(location.hash.split("?")[1] || "").get("type");
    location.hash = `#/market?${new URLSearchParams({ ...(type && { type }), ...(q && { q }) })}`;
  },
  async login(f) {
    const r = await api("/api/auth/login", { method: "POST", body: { email: f.email.value, password: f.password.value } });
    setToken(r.token);
    await refreshMe();
    toast(`Xin chào ${r.user.full_name}`);
    location.hash = "#/";
  },
  async register(f) {
    const r = await api("/api/auth/register", {
      method: "POST",
      body: { full_name: f.full_name.value, email: f.email.value, phone: f.phone.value, password: f.password.value, role: f.role.value },
    });
    setToken(r.token);
    await refreshMe();
    toast("Đăng ký thành công. Hãy hoàn tất eKYC.");
    router();
  },
  async kyc(f) {
    await api("/api/me/kyc", { method: "POST", body: { cccd_number: f.cccd_number.value, bank_name: f.bank_name.value, bank_account_number: f.bank_account_number.value } });
    await refreshMe();
    toast("Đã gửi hồ sơ eKYC, vui lòng chờ duyệt.");
    router();
  },
  async "buy-primary"(f) {
    const r = await api("/api/orders/create", { method: "POST", body: { asset_id: currentAsset.id, token_amount: f.qty.value } });
    location.hash = `#/pay/${r.transaction_id}`;
  },
  async "buy-otc"(f) {
    const r = await api("/api/orders/create", { method: "POST", body: { listing_id: f.listing_id.value, token_amount: f.qty.value } });
    location.hash = `#/pay/${r.transaction_id}`;
  },
  async sell(f) {
    await api("/api/otc/listings", { method: "POST", body: { asset_id: f.asset_id.value, token_amount: f.qty.value, price_per_token: f.price.value } });
    closeModal();
    toast("Đã đặt lệnh bán. Token được khóa cho tới khi khớp hoặc hủy.");
    router();
  },
  async proposal(f) {
    const type = f.proposal_type.value;
    await api(`/api/assets/${currentAsset.id}/proposals`, {
      method: "POST",
      body: {
        proposal_type: type,
        title: f.title.value,
        description: f.description.value,
        reward_bps: Math.round(Number(f.reward_pct.value) * 100),
        proposed_price: f.proposed_price.value || undefined,
        voting_days: Number(f.voting_days.value),
      },
    });
    toast("Đã tạo đề xuất");
    router();
  },
  async "list-asset"(f) {
    const type = f.asset_type.value;
    const t = state.meta.asset_types[type];
    const metadata = {};
    for (const fl of t.fields) metadata[fl.key] = f[`m_${fl.key}`].value;
    const documents = t.requiredDocs
      .map((_d, i) => ({ doc_type: "REQUIRED", title: f[`doc_title_${i}`].value, url: f[`doc_url_${i}`].value.trim(), sha256: f[`doc_sha_${i}`].value.trim() || undefined }))
      .filter((d) => d.url);
    const a = await api("/api/assets", {
      method: "POST",
      body: {
        asset_type: type,
        title: f.title.value,
        description: f.description.value,
        location: f.location.value,
        valuation_amount: f.valuation_amount.value,
        token_price: f.token_price.value,
        soft_cap_bps: Math.round(Number(f.soft_cap_pct.value) * 100),
        monthly_rent_commitment: f.monthly_rent_commitment.value || "0",
        is_sale_leaseback: f.is_sale_leaseback.checked,
        tags: f.tags.value.split(",").map((s) => s.trim()).filter(Boolean),
        metadata,
        documents,
      },
    });
    toast(`Đã gửi hồ sơ ${a.asset_code}, chờ thẩm định.`);
    location.hash = `#/asset/${a.id}`;
  },
  async spv(f) {
    await api("/api/admin/spv", { method: "POST", body: Object.fromEntries(new FormData(f)) });
    toast("Đã tạo SPV");
    router();
  },
  async approve(f) {
    await api(`/api/admin/assets/${f.id.value}/approve`, { method: "POST", body: { spv_id: f.spv_id.value } });
    closeModal();
    toast("Đã mở gọi vốn");
    router();
  },
  async rent(f, submitter) {
    const body = { gross_amount: f.gross.value, period: f.period.value, from_reserve: f.from_reserve.checked };
    if (submitter?.value === "preview") {
      const r = await api(`/api/admin/assets/${f.id.value}/rent/preview`, { method: "POST", body });
      document.getElementById("preview").innerHTML = `
        <div class="kv"><span>Doanh thu kỳ</span><b>${vnd(r.gross)}</b></div>
        <div class="kv"><span>Phí quản lý sàn</span><b>${vnd(r.platformFee)}</b></div>
        <div class="kv"><span>Thưởng người vận hành</span><b>${vnd(r.operatorReward)}</b></div>
        <div class="kv"><span>Lợi nhuận phân phối</span><b>${vnd(r.netDistributableAmount)}</b></div>
        <div class="kv"><span>Phần lẻ chưa chia</span><b>${vnd(r.dust)}</b></div>${previewTable(r.lines, "net")}`;
      return;
    }
    await api(`/api/admin/assets/${f.id.value}/rent/distribute`, { method: "POST", body });
    closeModal();
    toast("Đã chia cổ tức & tạo bảng kê chi");
    router();
  },
  async exit(f, submitter) {
    const body = { final_sale_price: f.price.value };
    if (submitter?.value === "preview") {
      const r = await api(`/api/admin/assets/${f.id.value}/exit/preview`, { method: "POST", body });
      document.getElementById("preview").innerHTML = `<div class="notice info">Kịch bản: <b>${esc({ DRAG_ALONG_PROFIT: "Drag-Along – bán lãi, chia theo tỷ lệ", DRAG_ALONG_LOSS: "Drag-Along – bán lỗ, ưu tiên mệnh giá gốc cho cổ đông nhỏ", VOTED_PRO_RATA: "Đã biểu quyết > 75%, chia theo tỷ lệ" }[r.mode])}</b></div>${previewTable(r.lines)}`;
      return;
    }
    if (!confirm("Tất toán sẽ hủy niêm yết tài sản và không thể hoàn tác. Tiếp tục?")) return;
    await api(`/api/admin/assets/${f.id.value}/exit/execute`, { method: "POST", body });
    closeModal();
    toast("Đã tất toán & tạo bảng kê chi");
    router();
  },
  async halt(f) {
    await api(`/api/admin/assets/${f.id.value}/halt`, { method: "POST", body: { notice_url: f.notice_url.value } });
    closeModal();
    toast("Đã tạm ngừng giao dịch & gửi thông báo khẩn");
    router();
  },
  async reject(f) {
    await api(`/api/admin/assets/${f.id.value}/reject`, { method: "POST", body: { reason: f.reason.value } });
    closeModal();
    router();
  },
};

const actions = {
  close: closeModal,
  print: () => window.print(),
  logout() {
    setToken(null);
    location.hash = "#/";
    router();
  },
  "buy-primary"() {
    if (!state.me) return (location.hash = "#/account");
    const a = currentAsset;
    const max = big(a.total_tokens) - big(a.sold_tokens) - big(a.reserved_tokens);
    qtyModal({ title: `Mua suất đầu tư ${a.asset_code}`, max: max.toString(), price: a.token_price, action: "buy-primary" });
  },
  "buy-otc"(el) {
    if (!state.me) return (location.hash = "#/account");
    qtyModal({ title: "Mua token trên thị trường OTC", max: el.dataset.max, price: el.dataset.price, action: "buy-otc", extra: `<input type="hidden" name="listing_id" value="${esc(el.dataset.id)}" />` });
  },
  sell(el) {
    openModal(`<h2>Đặt lệnh bán OTC</h2><form data-form="sell"><input type="hidden" name="asset_id" value="${esc(el.dataset.asset)}" />
      <div class="field"><label>Số lượng (khả dụng ${num(el.dataset.max)})</label><input name="qty" type="number" min="1" max="${esc(el.dataset.max)}" required /></div>
      <div class="field"><label>Giá chào bán / token (VND)</label><input name="price" type="number" min="1000" step="100" value="${esc(el.dataset.price)}" required /></div>
      <p class="small muted">Phí giao dịch ${pct(state.meta.fees.otc_fee_bps)} trừ vào tiền nhận. Tiền bán sẽ được giải ngân về tài khoản chính chủ qua bảng kê chi của ngân hàng.</p>
      <div class="row"><button class="btn">Đặt bán</button><button type="button" class="btn ghost" data-action="close">Hủy</button></div></form>`);
  },
  async vote(el) {
    if (!confirm(`Xác nhận biểu quyết "${el.dataset.d === "AGREE" ? "Đồng ý" : "Phản đối"}"? Token của bạn sẽ bị khóa chuyển nhượng tới khi kết thúc biểu quyết.`)) return;
    const r = await api(`/api/proposals/${el.dataset.id}/vote`, { method: "POST", body: { decision: el.dataset.d } });
    toast(r.status === "APPROVED" ? "Đề xuất đã được thông qua!" : "Đã ghi nhận biểu quyết");
    router();
  },
  async simulate(el) {
    const r = await api("/api/dev/simulate-payment", { method: "POST", body: { transaction_id: el.dataset.id } });
    toast(`Ngân hàng: ${r.result}`);
    router();
  },
  async "cancel-order"(el) {
    await api(`/api/orders/${el.dataset.id}/cancel`, { method: "POST", body: {} });
    toast("Đã hủy đơn");
    router();
  },
  async "cancel-listing"(el) {
    await api(`/api/otc/listings/${el.dataset.id}/cancel`, { method: "POST", body: {} });
    toast("Đã hủy lệnh bán");
    router();
  },
  async "adm-kyc"(el) {
    await api(`/api/admin/kyc/${el.dataset.id}`, { method: "POST", body: { approve: el.dataset.ok === "1" } });
    router();
  },
  "adm-approve"(el) {
    openModal(`<h2>Duyệt niêm yết</h2><form data-form="approve"><input type="hidden" name="id" value="${esc(el.dataset.id)}" />
      <div class="field"><label>Gán vào SPV</label><select name="spv_id">${window.__spvs.map((s) => `<option value="${esc(s.id)}">${esc(s.company_name)}</option>`).join("")}</select></div>
      <p class="small muted">Xác nhận đã thẩm định giá, kiểm tra hồ sơ pháp lý và ký hợp đồng góp vốn/chuyển nhượng tài sản vào SPV.</p>
      <button class="btn">Mở gọi vốn</button></form>`);
  },
  "adm-reject"(el) {
    openModal(`<h2>Yêu cầu bổ sung hồ sơ</h2><form data-form="reject"><input type="hidden" name="id" value="${esc(el.dataset.id)}" />
      <div class="field"><label>Lý do</label><textarea name="reason" required></textarea></div><button class="btn danger">Gửi</button></form>`);
  },
  async "adm-activate"(el) {
    if (!confirm("Xác nhận tài sản đã sang tên SPV và giải ngân cho chủ tài sản?")) return;
    const r = await api(`/api/admin/assets/${el.dataset.id}/activate`, { method: "POST", body: {} });
    toast(`Đã kích hoạt. Huy động ${vnd(r.raised)}, quỹ dự phòng ${vnd(r.reserve)}`);
    router();
  },
  async "adm-fail"(el) {
    if (!confirm("Hủy gọi vốn và hoàn tiền 100% cho nhà đầu tư?")) return;
    const r = await api(`/api/admin/assets/${el.dataset.id}/fail-funding`, { method: "POST", body: {} });
    toast(`Đã lập ${r.refunds} lệnh hoàn tiền`);
    router();
  },
  "adm-rent"(el) {
    const d = new Date();
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    openModal(`<h2>Chia cổ tức kỳ</h2><form data-form="rent"><input type="hidden" name="id" value="${esc(el.dataset.id)}" />
      <div class="field"><label>Kỳ (YYYY-MM)</label><input name="period" value="${period}" pattern="\\d{4}-\\d{2}" required /></div>
      <div class="field"><label>Doanh thu kỳ đã về tài khoản định danh (VND)</label><input name="gross" type="number" min="1" required /></div>
      <div class="field"><label class="checkbox"><input type="checkbox" name="from_reserve" /> Lấy từ quỹ dự phòng thuê (khi bên thuê chậm trả)</label></div>
      <div class="row"><button class="btn ghost" value="preview">Xem trước</button><button class="btn" value="run">Chia cổ tức</button></div>
      <div id="preview"></div></form>`);
  },
  "adm-exit"(el) {
    openModal(`<h2>Tất toán / Thoái vốn</h2><form data-form="exit"><input type="hidden" name="id" value="${esc(el.dataset.id)}" />
      <div class="field"><label>Giá bán cuối cùng / tiền bồi thường (VND)</label><input name="price" type="number" min="1" required /></div>
      <div class="row"><button class="btn ghost" value="preview">Xem phân bổ</button><button class="btn danger" value="run">Thực hiện tất toán</button></div>
      <div id="preview"></div></form>`);
  },
  "adm-halt"(el) {
    openModal(`<h2>Tạm ngừng giao dịch khẩn cấp</h2><form data-form="halt"><input type="hidden" name="id" value="${esc(el.dataset.id)}" />
      <div class="field"><label>URL văn bản thông báo chính thức (thu hồi đất, tranh chấp văn bằng, nghi vấn nguồn gốc…)</label><input name="notice_url" required placeholder="https://…" /></div>
      <p class="small muted">Toàn bộ lệnh bán & đơn chờ thanh toán sẽ bị hủy, token được trả về người bán, và mọi cổ đông nhận thông báo khẩn.</p>
      <button class="btn danger">Tạm ngừng</button></form>`);
  },
  async "adm-resume"(el) {
    await api(`/api/admin/assets/${el.dataset.id}/resume`, { method: "POST", body: {} });
    router();
  },
  async "adm-buyback"(el) {
    if (!confirm("Xác nhận chủ cũ đã nộp đủ tiền chuộc lại vào tài khoản phong tỏa?")) return;
    await api(`/api/admin/proposals/${el.dataset.id}/buyback`, { method: "POST", body: {} });
    toast("Đã thực hiện chuộc lại");
    router();
  },
  async "adm-csv"(el) {
    const res = await fetch(`/api/admin/batches/${el.dataset.id}/csv`, { headers: { Authorization: `Bearer ${state.token}` } });
    if (!res.ok) throw new Error("Không tải được bảng kê");
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `bang-ke-chi-${el.dataset.id.slice(0, 8)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  },
  async "adm-paid"(el) {
    if (!confirm("Xác nhận đã thực hiện chi trên ứng dụng ngân hàng?")) return;
    await api(`/api/admin/batches/${el.dataset.id}/paid`, { method: "POST", body: {} });
    router();
  },
};

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(err.message, true);
  }
});

document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-form]");
  if (!f) return;
  e.preventDefault();
  const btns = f.querySelectorAll("button");
  for (const b of btns) b.disabled = true;
  try {
    await forms[f.dataset.form](f, e.submitter);
  } catch (err) {
    toast(err.code === "KYC_REQUIRED" ? "Bạn cần hoàn tất eKYC (mục Tài khoản) trước." : err.message, true);
  } finally {
    for (const b of btns) b.disabled = false;
  }
});

window.addEventListener("hashchange", router);

(async () => {
  state.meta = await api("/api/meta");
  await refreshMe();
  router();
})();
