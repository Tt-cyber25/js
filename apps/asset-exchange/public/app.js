// TokenVN – SPA thuần (không framework), mobile-first.
// An toàn: mọi dữ liệu động đều đi qua esc() trước khi chèn HTML; không dùng inline script/handler (CSP).

const $app = document.getElementById("app");
const state = { token: localStorage.getItem("tvn_token"), me: null, meta: null, unread: 0, poll: null, onMarket: null, es: null };

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
  DIVIDEND: "Cổ tức",
  REFUND: "Hoàn tiền",
  EXIT_PAYOUT: "Tất toán",
  OWNER_DISBURSEMENT: "Giải ngân chủ TS",
  DEPOSIT: "Nạp tiền",
  WITHDRAWAL: "Rút tiền",
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
    ["#/board", "📊", "Bảng giá", (x) => x === "#/" || x.startsWith("#/board")],
    ["#/market", "🏛️", "Gọi vốn", (x) => x.startsWith("#/market") || x.startsWith("#/asset")],
    ["#/trade", "⚡", "Giao dịch", (x) => x.startsWith("#/trade")],
    ["#/portfolio", "💼", "Tài sản", (x) => x.startsWith("#/portfolio") || x.startsWith("#/pay")],
  ];
  if (state.me?.role === "ADMIN") items.push(["#/admin", "🛡️", "Quản trị", (x) => x.startsWith("#/admin")]);
  items.push(["#/account", "👤", "Tài khoản", (x) => x.startsWith("#/account") || x.startsWith("#/list-asset")]);
  document.getElementById("bottomnav").innerHTML = items
    .map(([h, ic, l, test]) => `<a href="${h}" class="${test(r) ? "active" : ""}"><span class="ic">${ic}</span>${l}</a>`)
    .join("");
  const bell = `<a class="bell" href="#/notifications" aria-label="Thông báo">🔔${state.unread > 0 ? `<span class="badge">${esc(state.unread)}</span>` : ""}</a>`;
  document.getElementById("topbar-right").innerHTML = state.me
    ? `<div class="row">${bell}<span class="pill">${esc(state.me.full_name)}</span></div>`
    : `<a class="btn sm gold" href="#/account">Đăng nhập</a>`;
}

// Luồng giá thời gian thực (SSE): báo mã nào vừa có thay đổi để màn hình đang mở tự cập nhật
function startStream() {
  if (state.es || !window.EventSource) return;
  state.es = new EventSource("/api/stream");
  let timer;
  const pendingIds = new Set();
  state.es.addEventListener("market", (e) => {
    for (const id of JSON.parse(e.data)) pendingIds.add(id);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const ids = [...pendingIds];
      pendingIds.clear();
      state.onMarket?.(ids);
    }, 120);
  });
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
  state.onMarket = null;
  document.body.classList.remove("has-buybar");
  closeModal();
  const [pathPart, qs = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [path, ...rest] = pathPart.split("/");
  const arg = rest.map(decodeURIComponent);
  navBar();
  try {
    if (path === "" || path === "board") await viewBoard(new URLSearchParams(qs));
    else if (path === "market") await viewMarket(new URLSearchParams(qs));
    else if (path === "trade") await viewTrade(arg[0]);
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
      <a class="chip ${type ? "" : "active"}" href="#/market">Tất cả</a>
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
    ["market", "Thị trường"],
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
                 <div class="row"><a class="btn sm ghost" href="#/cert/${esc(a.id)}">Giấy xác nhận sở hữu</a>${a.status === "ACTIVE" ? `<a class="btn sm" href="#/trade/${esc(a.id)}">Mua / Bán</a>` : ""}</div>`
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
    const m = a.market;
    body = m
      ? `<div class="card"><h3>Thông tin giao dịch hôm nay</h3>
          <div class="kv"><span>Giá khớp gần nhất</span><b class="${pcls(m.last, m)}">${num(m.last)}</b></div>
          <div class="kv"><span>Tham chiếu / Trần / Sàn</span><b><span class="c-ref">${num(m.ref)}</span> / <span class="c-ceil">${num(m.ceiling)}</span> / <span class="c-floor">${num(m.floor)}</span></b></div>
          <div class="kv"><span>Cao / Thấp</span><b>${m.high ? num(m.high) : "—"} / ${m.low ? num(m.low) : "—"}</b></div>
          <div class="kv"><span>Khối lượng / Giá trị</span><b>${num(m.volume)} / ${vnd(m.value)}</b></div>
          <div class="kv"><span>Vốn hóa</span><b>${vnd(m.market_cap)}</b></div>
          <a class="btn gold block" href="#/trade/${esc(a.id)}">Mở màn hình giao dịch</a></div>`
      : `<div class="card notice">Tài sản chỉ được giao dịch trên sàn sau khi hoàn tất gọi vốn và sang tên SPV.</div>`;
  }

  let buybar = "";
  if (a.status === "FUNDING") {
    buybar = `<div class="buybar"><div><div class="small muted">Giá suất</div><div class="price">${vnd(a.token_price)}</div><div class="small muted">Còn ${num(remaining)} token</div></div>
      <button class="btn gold" data-action="buy-primary" ${remaining > 0n ? "" : "disabled"}>Mua suất đầu tư</button></div>`;
  } else if (a.status === "ACTIVE") {
    buybar = `<div class="buybar"><div><div class="small muted">Giá gần nhất</div><div class="price">${vnd(a.last_price)}</div></div>
      <a class="btn gold" href="#/trade/${esc(a.id)}">⚡ Giao dịch</a></div>`;
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

function qtyModal({ title, max, price, action, extra = "", wallet = false }) {
  openModal(`<h2>${esc(title)}</h2>
    <form data-form="${action}">${extra}
      <div class="field"><label>Số lượng token (tối đa ${num(max)})</label><input name="qty" type="number" min="1" max="${esc(max)}" step="1" value="${big(max) < 100n ? esc(max) : "100"}" required data-price="${esc(price)}" /></div>
      <div class="kv"><span>Đơn giá</span><b>${vnd(price)}</b></div>
      <div class="kv"><span>Thành tiền</span><b id="qty-total">—</b></div>
      ${wallet ? '<div class="field"><label class="checkbox"><input type="checkbox" name="from_wallet" /> Thanh toán ngay bằng số dư ví</label></div>' : ""}
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
      <div class="small muted">${esc(TX[o.type])}${o.asset ? ` · ${esc(o.asset.asset_code)} – ${esc(o.asset.title)}` : " vào ví giao dịch"}</div>
      ${o.asset ? `<div class="kv"><span>Số token</span><b>${num(o.token_amount)}</b></div>` : ""}
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
          : `<p>${o.status === "COMPLETED" && o.type === "DEPOSIT" ? "Tiền đã được cộng vào ví, bạn có thể đặt lệnh ngay." : ""}${o.status === "COMPLETED" && o.type !== "DEPOSIT" ? (o.type === "BUY_PRIMARY" ? "Token đã ghi nhận vào danh mục ở trạng thái <b>chờ hoàn tất gọi vốn</b>; sẽ mở khóa khi tài sản sang tên SPV." : "Token đã chuyển vào danh mục của bạn.") : ""}</p>`
      }
      <div class="row">${o.asset ? `<a class="btn ghost" href="#/asset/${esc(o.asset.id)}">Về tài sản</a>` : '<a class="btn ghost" href="#/board">Bảng giá</a>'}<a class="btn ghost" href="#/portfolio">Tài sản của tôi</a></div></div>`);
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
  const w = p.wallet;
  const pnl = big(p.securities_value) - big(p.cost_total);
  render(`
    <div class="card nav-card">
      <div class="small muted">Tổng tài sản ròng (NAV)</div><div class="big">${vnd(p.net_worth)}</div>
      <div class="grid two-col small">
        <div><div class="muted">Tiền khả dụng</div><b>${vnd(w.available)}</b></div>
        <div><div class="muted">Tiền chờ khớp (phong tỏa)</div><b>${vnd(w.locked)}</b></div>
        <div><div class="muted">Giá trị token</div><b>${vnd(p.securities_value)}</b></div>
        <div><div class="muted">Lãi/lỗ tạm tính</div><b class="${pnl >= 0n ? "up" : "down"}">${pnl >= 0n ? "+" : ""}${vnd(pnl)}</b></div>
      </div>
      <div class="small">Cổ tức đã nhận (sau thuế): <b class="up">${vnd(p.dividends_total)}</b></div>
      <div class="row"><button class="btn gold" data-action="deposit">＋ Nạp tiền</button><button class="btn ghost" data-action="withdraw" data-max="${esc(w.available)}">Rút tiền</button><a class="btn ghost" href="#/trade">⚡ Giao dịch</a></div>
    </div>
    <h2>Danh mục token</h2>
    ${
      p.holdings
        .map((h) => {
          const qty = big(h.available_tokens) + big(h.locked_tokens);
          const pl = big(h.market_value) - big(h.cost_basis);
          const plPct = big(h.cost_basis) > 0n ? ratio(pl, h.cost_basis) : 0;
          return `<div class="card holding"><div class="row between"><a href="#/asset/${esc(h.asset_id)}"><b>${esc(h.asset_code)}</b></a>${pill(h.status)}</div>
            <div class="small muted">${esc(h.title)}</div>
            <div class="grid two-col small">
              <div><div class="muted">Khối lượng</div><b>${num(qty)}</b>${big(h.locked_tokens) > 0n ? `<div class="muted">khóa ${num(h.locked_tokens)}</div>` : ""}</div>
              <div><div class="muted">Giá vốn / Giá TT</div><b>${num(h.avg_buy_price)} / ${num(h.last_price)}</b></div>
              <div><div class="muted">Giá trị</div><b>${vnd(h.market_value)}</b></div>
              <div><div class="muted">Lãi/lỗ</div><b class="${pl >= 0n ? "up" : "down"}">${pl >= 0n ? "+" : ""}${num(pl)} (${plPct}%)</b></div>
            </div>
            <div class="row"><a class="btn sm ghost" href="#/cert/${esc(h.asset_id)}">📄 Giấy xác nhận</a>
            ${h.status === "ACTIVE" ? `<a class="btn sm" href="#/trade/${esc(h.asset_id)}">Mua / Bán</a>` : ""}</div></div>`;
        })
        .join("") || '<div class="card muted">Bạn chưa sở hữu token nào. <a href="#/board">Xem bảng giá</a> hoặc <a href="#/market">tham gia gọi vốn</a>.</div>'
    }
    <h2>Lịch sử tiền & cổ tức</h2>
    <div class="card table-wrap"><table><tr><th>Thời gian</th><th>Loại</th><th>TS</th><th class="num">Token</th><th class="num">Số tiền</th><th>Trạng thái</th></tr>
      ${p.transactions.map((t) => `<tr><td class="small">${esc(date(t.created_at))}</td><td>${esc(TX[t.type] || t.type)}${t.tax_amount !== "0" ? `<div class="small muted">Thuế ${num(t.tax_amount)}</div>` : ""}</td><td>${esc(t.asset_code || "Ví")}</td><td class="num">${t.token_amount !== "0" ? num(t.token_amount) : ""}</td><td class="num">${num(t.net_amount)}</td><td>${t.status === "PENDING" ? `<a href="#/pay/${esc(t.id)}">${esc(TXST[t.status])}</a>` : esc(TXST[t.status] || t.status)}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Chưa có giao dịch.</td></tr>'}
    </table></div>`);
}

// ---------- BẢNG GIÁ ----------
const WATCH_KEY = "tvn_watchlist";
const watchlist = () => new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || "[]"));
function toggleWatch(id) {
  const w = watchlist();
  w.has(id) ? w.delete(id) : w.add(id);
  localStorage.setItem(WATCH_KEY, JSON.stringify([...w]));
}
// Màu giá theo quy ước bảng điện: trần tím, sàn xanh lam, tham chiếu vàng, tăng xanh, giảm đỏ
function pcls(price, m) {
  if (price === null || price === undefined) return "";
  const p = big(price);
  if (p >= big(m.ceiling)) return "c-ceil";
  if (p <= big(m.floor)) return "c-floor";
  if (p === big(m.ref)) return "c-ref";
  return p > big(m.ref) ? "up" : "down";
}
const chg = (m) => `${big(m.change) > 0n ? "+" : ""}${num(m.change)}`;
const chgPct = (m) => `${big(m.change_bps) > 0n ? "+" : ""}${(Number(m.change_bps) / 100).toFixed(2)}%`;

let boardPrev = new Map();
async function viewBoard(qs) {
  const filter = qs.get("f") || "all";
  const full = localStorage.getItem("tvn_board_full") === "1";
  const load = async () => {
    const rows = await api("/api/market/board");
    const w = watchlist();
    const list = rows.filter((r) => (filter === "all" ? true : filter === "watch" ? w.has(r.id) : r.asset_type === filter));
    const up = rows.filter((r) => big(r.change) > 0n).length;
    const down = rows.filter((r) => big(r.change) < 0n).length;
    const value = rows.reduce((s, r) => s + big(r.value), 0n);
    document.getElementById("board-stats").innerHTML = `
      <div><div class="muted small">Giá trị khớp hôm nay</div><b>${vnd(value)}</b></div>
      <div><div class="muted small">Tăng / Đứng / Giảm</div><b><span class="up">${up}</span> / <span class="c-ref">${rows.length - up - down}</span> / <span class="down">${down}</span></b></div>`;
    const lv = (arr, i, m) => (arr[i] ? `<td class="num ${pcls(arr[i].price, m)}">${num(arr[i].price)}</td><td class="num ${pcls(arr[i].price, m)}">${num(arr[i].qty)}</td>` : "<td></td><td></td>");
    const star = (r) => `<button class="star ${w.has(r.id) ? "on" : ""}" data-action="watch" data-id="${esc(r.id)}" aria-label="Theo dõi">★</button>`;
    const flash = (r) => {
      const prev = boardPrev.get(r.id);
      boardPrev.set(r.id, r.last);
      if (prev === undefined || prev === r.last) return "";
      return big(r.last) > big(prev) ? "flash-up" : "flash-down";
    };
    const body = list
      .map((r) => {
        const f = flash(r);
        const icon = state.meta.asset_types[r.asset_type]?.icon || "";
        if (!full) {
          return `<tr data-href="#/trade/${esc(r.id)}">
            <td>${star(r)}</td><td><b>${icon} ${esc(r.asset_code)}</b>${r.status === "HALTED_PLANNING" ? ' <span class="pill st-HALTED_PLANNING">Ngừng GD</span>' : ""}<div class="small muted">KL ${num(r.volume)}</div></td>
            <td class="num ${pcls(r.last, r)} ${f}"><b>${num(r.last)}</b></td>
            <td class="num"><span class="chgbox ${pcls(r.last, r)}">${chgPct(r)}</span></td></tr>`;
        }
        return `<tr data-href="#/trade/${esc(r.id)}"><td>${star(r)}</td><td><b>${esc(r.asset_code)}</b></td>
          <td class="num c-ceil">${num(r.ceiling)}</td><td class="num c-floor">${num(r.floor)}</td><td class="num c-ref">${num(r.ref)}</td>
          ${lv(r.bids, 2, r)}${lv(r.bids, 1, r)}${lv(r.bids, 0, r)}
          <td class="num ${pcls(r.last, r)} ${f}"><b>${num(r.last)}</b></td><td class="num ${pcls(r.last, r)}">${num(r.last_qty)}</td><td class="num ${pcls(r.last, r)}">${chg(r)}</td><td class="num ${pcls(r.last, r)}">${chgPct(r)}</td>
          ${lv(r.asks, 0, r)}${lv(r.asks, 1, r)}${lv(r.asks, 2, r)}
          <td class="num">${num(r.volume)}</td><td class="num ${pcls(r.high, r)}">${r.high ? num(r.high) : ""}</td><td class="num ${pcls(r.low, r)}">${r.low ? num(r.low) : ""}</td></tr>`;
      })
      .join("");
    const head = full
      ? `<tr><th></th><th>Mã</th><th class="num">Trần</th><th class="num">Sàn</th><th class="num">TC</th>
          <th class="num">Giá 3</th><th class="num">KL 3</th><th class="num">Giá 2</th><th class="num">KL 2</th><th class="num">Giá 1</th><th class="num">KL 1</th>
          <th class="num">Khớp</th><th class="num">KL</th><th class="num">+/-</th><th class="num">%</th>
          <th class="num">Giá 1</th><th class="num">KL 1</th><th class="num">Giá 2</th><th class="num">KL 2</th><th class="num">Giá 3</th><th class="num">KL 3</th>
          <th class="num">Tổng KL</th><th class="num">Cao</th><th class="num">Thấp</th></tr>`
      : `<tr><th></th><th>Mã / KL</th><th class="num">Giá</th><th class="num">+/- %</th></tr>`;
    document.getElementById("board").innerHTML = `<table class="board ${full ? "full" : ""}">${head}${body || `<tr><td colspan="24" class="muted">${filter === "watch" ? "Chưa có mã theo dõi — bấm ★ để thêm." : "Chưa có mã giao dịch."}</td></tr>`}</table>`;
  };
  const types = Object.entries(state.meta.asset_types);
  render(`
    <div class="card board-head"><div class="row between"><h1>Bảng giá</h1><button class="btn sm ghost" data-action="board-mode">${full ? "Chế độ gọn" : "Chế độ đầy đủ"}</button></div>
      <div class="grid two-col" id="board-stats"></div>
      <div class="small muted">Giá cập nhật theo thời gian thực. Biên độ ±${pct(state.meta.fees.band_bps)} quanh giá tham chiếu, bước giá ${num(state.meta.fees.tick_size)}đ.</div></div>
    <div class="chips">
      <a class="chip ${filter === "all" ? "active" : ""}" href="#/board">Tất cả</a>
      <a class="chip ${filter === "watch" ? "active" : ""}" href="#/board?f=watch">★ Theo dõi</a>
      ${types.map(([k, t]) => `<a class="chip ${filter === k ? "active" : ""}" href="#/board?f=${k}">${t.icon} ${esc(t.label)}</a>`).join("")}
    </div>
    <div class="card table-wrap flush" id="board"></div>
    <div class="legend small"><span class="c-ceil">■ Trần</span><span class="c-floor">■ Sàn</span><span class="c-ref">■ Tham chiếu</span><span class="up">■ Tăng</span><span class="down">■ Giảm</span></div>`);
  await load();
  state.onMarket = () => load().catch(() => {});
}

// ---------- MÀN HÌNH GIAO DỊCH ----------
const ts = { side: "BUY", type: "LIMIT", interval: "1h", tab: "open" };

function candleChart(cs) {
  if (cs.length < 2) return '<p class="muted small chart-empty">Chưa đủ dữ liệu khớp lệnh trong khung thời gian này.</p>';
  const W = 600;
  const H = 260;
  const VH = 50;
  const n = cs.length;
  const hi = Math.max(...cs.map((c) => c.h));
  const lo = Math.min(...cs.map((c) => c.l));
  const pad = (hi - lo) * 0.08 || hi * 0.01;
  const top = hi + pad;
  const bot = lo - pad;
  const y = (p) => ((top - p) / (top - bot)) * (H - VH - 10) + 5;
  const step = W / n;
  const bw = Math.max(1.5, step * 0.65);
  const vmax = Math.max(...cs.map((c) => c.v)) || 1;
  let out = "";
  cs.forEach((c, i) => {
    const x = i * step + step / 2;
    const upC = c.c >= c.o;
    const cls = upC ? "cu" : "cd";
    out += `<line class="${cls}" x1="${x}" x2="${x}" y1="${y(c.h)}" y2="${y(c.l)}"/>`;
    const y1 = y(Math.max(c.o, c.c));
    const hgt = Math.max(1, Math.abs(y(c.o) - y(c.c)));
    out += `<rect class="${cls}" x="${x - bw / 2}" y="${y1}" width="${bw}" height="${hgt}"/>`;
    const vh = (c.v / vmax) * (VH - 6);
    out += `<rect class="${cls} vol" x="${x - bw / 2}" y="${H - vh}" width="${bw}" height="${vh}"/>`;
  });
  // Đường trung bình động MA(7)
  const ma = cs.map((_c, i) => (i < 6 ? null : cs.slice(i - 6, i + 1).reduce((s, c) => s + c.c, 0) / 7));
  const pts = ma.map((v, i) => (v === null ? null : `${(i * step + step / 2).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean);
  if (pts.length > 1) out += `<polyline class="ma" points="${pts.join(" ")}"/>`;
  const last = cs.at(-1);
  out += `<line class="lastline" x1="0" x2="${W}" y1="${y(last.c)}" y2="${y(last.c)}"/>`;
  return `<div class="chart-wrap"><svg class="candles" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Biểu đồ nến">${out}</svg>
    <div class="axis-r"><span>${num(Math.round(top))}</span><span>${num(Math.round((top + bot) / 2))}</span><span>${num(Math.round(bot))}</span></div></div>
    <div class="small muted ohlc">O <b>${num(last.o)}</b> H <b>${num(last.h)}</b> L <b>${num(last.l)}</b> C <b>${num(last.c)}</b> · KL ${num(last.v)} · <span class="ma-legend">— MA(7)</span></div>`;
}

function bookHtml(d, m) {
  const max = Math.max(1, ...d.asks.map((x) => Number(x.qty)), ...d.bids.map((x) => Number(x.qty)));
  const row = (l, side) =>
    `<div class="book-row ${side}" data-action="pick-price" data-price="${esc(l.price)}"><div class="depth" data-w="${(Number(l.qty) / max) * 100}"></div>
      <span class="${pcls(l.price, m)}">${num(l.price)}</span><span>${num(l.qty)}</span></div>`;
  const asks = d.asks.slice(0, 8).reverse().map((l) => row(l, "ask")).join("");
  const bids = d.bids.slice(0, 8).map((l) => row(l, "bid")).join("");
  return `<div class="book-head small muted"><span>Giá</span><span>KL</span></div>
    <div class="book-side">${asks || '<div class="small muted center">Chưa có lệnh bán</div>'}</div>
    <div class="book-mid ${pcls(m.last, m)}">${num(m.last)} <span class="small">${chgPct(m)}</span></div>
    <div class="book-side">${bids || '<div class="small muted center">Chưa có lệnh mua</div>'}</div>`;
}

async function viewTrade(id) {
  const board = await api("/api/market/board");
  if (!board.length) return render('<div class="card">Chưa có tài sản nào đang giao dịch.</div>');
  const sel = board.find((b) => b.id === id || b.asset_code === id) || board[0];
  if (!id) history.replaceState(null, "", `#/trade/${sel.id}`);
  const assetId = sel.id;
  const fee = Number(state.meta.fees.trade_fee_bps) / 10000;
  const tax = Number(state.meta.fees.sell_tax_bps) / 10000;
  let m = sel;
  let bal = null;

  render(`
    <div class="card t-head" id="t-head"></div>
    <div class="t-grid">
      <div class="card t-chart">
        <div class="row between"><div class="seg" id="t-int">${["15m", "1h", "4h", "1d"].map((i) => `<button class="${ts.interval === i ? "on" : ""}" data-action="interval" data-i="${i}">${i === "1d" ? "1D" : i}</button>`).join("")}</div>
        <a class="small" href="#/asset/${esc(assetId)}">Hồ sơ tài sản →</a></div>
        <div id="t-chart"></div>
      </div>
      <div class="card t-book"><div id="t-book"></div></div>
      <div class="card t-form">
        <div class="seg sides"><button data-action="side" data-s="BUY" class="${ts.side === "BUY" ? "on buy" : ""}">Mua</button><button data-action="side" data-s="SELL" class="${ts.side === "SELL" ? "on sell" : ""}">Bán</button></div>
        <div class="seg types">${[["LIMIT", "LO"], ["MARKET", "MP"], ["STOP_LIMIT", "Dừng"]].map(([k, l]) => `<button data-action="otype" data-t="${k}" class="${ts.type === k ? "on" : ""}">${l}</button>`).join("")}</div>
        <form data-form="order" id="order-form" autocomplete="off">
          <div class="field ${ts.type === "STOP_LIMIT" ? "" : "hidden"}"><label>Giá kích hoạt</label><input name="stop_price" inputmode="numeric" /></div>
          <div class="field ${ts.type === "MARKET" ? "hidden" : ""}"><label>Giá đặt</label>
            <div class="stepper"><button type="button" data-action="step" data-d="-1">−</button><input name="price" inputmode="numeric" value="${esc(sel.last)}" /><button type="button" data-action="step" data-d="1">+</button></div></div>
          ${ts.type === "MARKET" ? '<p class="small muted">Lệnh thị trường khớp ngay với giá tốt nhất trên sổ lệnh, phần chưa khớp tự hủy.</p>' : ""}
          <div class="field"><label>Khối lượng</label><input name="qty" inputmode="numeric" placeholder="0" /></div>
          <div class="seg pcts">${[25, 50, 75, 100].map((x) => `<button type="button" data-action="pct" data-p="${x}">${x}%</button>`).join("")}</div>
          <div class="small" id="t-sum"></div>
          ${state.me ? `<button class="btn block ${ts.side === "BUY" ? "buy" : "sell"}">${ts.side === "BUY" ? "Đặt MUA" : "Đặt BÁN"} ${esc(sel.asset_code)}</button>` : '<a class="btn block" href="#/account">Đăng nhập để giao dịch</a>'}
        </form>
      </div>
      <div class="card t-trades"><h3>Khớp lệnh gần đây</h3><div id="t-trades"></div></div>
    </div>
    <div class="card">
      <div class="tabs">${[["open", "Lệnh chờ"], ["history", "Lịch sử lệnh"], ["fills", "Khớp của tôi"], ["alerts", "Cảnh báo giá"]].map(([k, l]) => `<button class="tab ${ts.tab === k ? "active" : ""}" data-action="otab" data-k="${k}">${l}</button>`).join("")}</div>
      <div id="t-orders"></div>
    </div>`);

  const form = document.getElementById("order-form");
  const sumEl = document.getElementById("t-sum");
  const updateSum = () => {
    const q = Number(form.qty.value) || 0;
    const p = ts.type === "MARKET" ? Number(ts.side === "BUY" ? m.ceiling : m.last) : Number(form.price.value) || 0;
    const val = q * p;
    const f = Math.floor(val * fee);
    const t = ts.side === "SELL" ? Math.floor(val * tax) : 0;
    const avail = bal ? (ts.side === "BUY" ? `${vnd(bal.cash.available)}` : `${num(bal.holding.available_tokens)} token`) : "—";
    sumEl.innerHTML = `<div class="kv"><span>Khả dụng</span><b>${avail}</b></div>
      <div class="kv"><span>Giá trị${ts.type === "MARKET" ? " (ước tính)" : ""}</span><b>${vnd(Math.round(val))}</b></div>
      <div class="kv"><span>Phí ${pct(state.meta.fees.trade_fee_bps)}${ts.side === "SELL" ? ` + thuế ${pct(state.meta.fees.sell_tax_bps)}` : ""}</span><b>${vnd(f + t)}</b></div>
      <div class="kv"><span>${ts.side === "BUY" ? "Tổng thanh toán" : "Thực nhận"}</span><b>${vnd(ts.side === "BUY" ? val + f : val - f - t)}</b></div>`;
  };
  form.addEventListener("input", updateSum);
  ts.form = { form, updateSum, assetId, get m() { return m; }, get bal() { return bal; } };

  const loadHead = async () => {
    m = await api(`/api/market/${assetId}/summary`);
    const t = state.meta.asset_types[sel.asset_type];
    document.getElementById("t-head").innerHTML = `
      <div class="row between"><select id="t-select" aria-label="Chọn mã">${board.map((b) => `<option value="${esc(b.id)}" ${b.id === assetId ? "selected" : ""}>${esc(b.asset_code)} – ${esc(b.title.slice(0, 40))}</option>`).join("")}</select>
        <button class="star ${watchlist().has(assetId) ? "on" : ""}" data-action="watch" data-id="${esc(assetId)}">★</button></div>
      <div class="row t-price"><span class="big ${pcls(m.last, m)}">${num(m.last)}</span><span class="chgbox ${pcls(m.last, m)}">${chg(m)} (${chgPct(m)})</span>${sel.status === "HALTED_PLANNING" ? pill("HALTED_PLANNING") : ""}</div>
      <div class="t-stats small">
        <div><span class="muted">TC</span> <b class="c-ref">${num(m.ref)}</b></div><div><span class="muted">Trần</span> <b class="c-ceil">${num(m.ceiling)}</b></div><div><span class="muted">Sàn</span> <b class="c-floor">${num(m.floor)}</b></div>
        <div><span class="muted">Cao</span> <b>${m.high ? num(m.high) : "—"}</b></div><div><span class="muted">Thấp</span> <b>${m.low ? num(m.low) : "—"}</b></div><div><span class="muted">KL</span> <b>${num(m.volume)}</b></div>
        <div><span class="muted">GT</span> <b>${num(m.value)}</b></div><div><span class="muted">KL 24h</span> <b>${num(m.volume_24h)}</b></div><div><span class="muted">${esc(t?.icon || "")}</span> <b>${esc(t?.label || "")}</b></div>
      </div>`;
    document.getElementById("t-select").addEventListener("change", (e) => {
      location.hash = `#/trade/${e.target.value}`;
    });
  };
  const loadChart = async () => {
    document.getElementById("t-chart").innerHTML = candleChart(await api(`/api/market/${assetId}/candles?interval=${ts.interval}&limit=120`));
  };
  const loadBook = async () => {
    const el = document.getElementById("t-book");
    el.innerHTML = bookHtml(await api(`/api/market/${assetId}/depth`), m);
    applyDynamic(el);
  };
  const loadTrades = async () => {
    const tr = await api(`/api/market/${assetId}/trades?limit=30`);
    document.getElementById("t-trades").innerHTML = `<div class="trades-list small"><div class="muted"><span>Giờ</span><span>Giá</span><span>KL</span></div>${tr
      .map((x) => `<div><span class="muted">${esc(date(x.created_at).split(" ")[0])}</span><span class="${x.taker_side === "BUY" ? "up" : "down"}">${num(x.price)}</span><span>${num(x.quantity)}</span></div>`)
      .join("")}</div>`;
  };
  const loadMine = async () => {
    const el = document.getElementById("t-orders");
    if (!state.me) {
      el.innerHTML = '<p class="muted small">Đăng nhập để xem lệnh của bạn.</p>';
      return;
    }
    bal = await api(`/api/exchange/balance?asset_id=${assetId}`);
    updateSum();
    const OT = { LIMIT: "LO", MARKET: "MP", STOP_LIMIT: "Dừng" };
    const OS = { OPEN: "Chờ khớp", PARTIAL: "Khớp 1 phần", PENDING_TRIGGER: "Chờ kích hoạt", FILLED: "Đã khớp", CANCELLED: "Đã hủy" };
    if (ts.tab === "open" || ts.tab === "history") {
      const list = await api(`/api/exchange/orders?status=${ts.tab}`);
      el.innerHTML = `<div class="table-wrap"><table><tr><th>Mã</th><th>Lệnh</th><th class="num">Giá</th><th class="num">KL khớp/đặt</th><th>Trạng thái</th><th></th></tr>
        ${list.map((o) => `<tr><td>${esc(o.asset_code)}</td><td class="${o.side === "BUY" ? "up" : "down"}">${o.side === "BUY" ? "Mua" : "Bán"} ${OT[o.type]}</td>
          <td class="num">${o.price ? num(o.price) : "MP"}${o.stop_price ? `<div class="small muted">KH ${num(o.stop_price)}</div>` : ""}</td><td class="num">${num(o.filled_quantity)}/${num(o.quantity)}</td>
          <td class="small">${esc(OS[o.status])}${o.cancel_reason && o.cancel_reason !== "USER" ? `<div class="muted">${esc(o.cancel_reason)}</div>` : ""}</td>
          <td class="num">${ts.tab === "open" ? `<button class="btn sm ghost" data-action="cancel-xorder" data-id="${esc(o.id)}">Hủy</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Không có lệnh.</td></tr>'}</table></div>`;
    } else if (ts.tab === "fills") {
      const list = await api("/api/exchange/my-trades");
      el.innerHTML = `<div class="table-wrap"><table><tr><th>Thời gian</th><th>Mã</th><th>Chiều</th><th class="num">Giá</th><th class="num">KL</th><th class="num">Phí+thuế</th></tr>
        ${list.map((t) => `<tr><td class="small">${esc(date(t.created_at))}</td><td>${esc(t.asset_code)}</td><td class="${t.side === "BUY" ? "up" : "down"}">${t.side === "BUY" ? "Mua" : "Bán"}</td><td class="num">${num(t.price)}</td><td class="num">${num(t.quantity)}</td><td class="num">${num(big(t.fee) + big(t.tax))}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">Chưa có giao dịch khớp.</td></tr>'}</table></div>`;
    } else {
      const list = await api("/api/alerts");
      el.innerHTML = `<form data-form="alert" class="row alert-form"><select name="direction"><option value="ABOVE">Giá ≥</option><option value="BELOW">Giá ≤</option></select>
          <input name="price" inputmode="numeric" placeholder="Mức giá" required /><button class="btn sm">Tạo cảnh báo ${esc(sel.asset_code)}</button></form>
        <table><tr><th>Mã</th><th>Điều kiện</th><th>Trạng thái</th><th></th></tr>
        ${list.map((a) => `<tr><td>${esc(a.asset_code)}</td><td>${a.direction === "ABOVE" ? "≥" : "≤"} ${num(a.price)}</td><td class="small">${Number(a.active) ? "Đang theo dõi" : `Đã báo ${esc(date(a.triggered_at))}`}</td><td class="num"><button class="btn sm ghost" data-action="del-alert" data-id="${esc(a.id)}">Xóa</button></td></tr>`).join("") || '<tr><td colspan="4" class="muted">Chưa có cảnh báo.</td></tr>'}</table>`;
    }
  };
  ts.reloadMine = loadMine;
  ts.reloadChart = loadChart;
  await loadHead();
  await Promise.all([loadChart(), loadBook(), loadTrades(), loadMine()]);
  updateSum();
  state.onMarket = (ids) => {
    if (!ids.includes(assetId)) return;
    loadHead()
      .then(() => Promise.all([loadBook(), loadTrades(), loadChart(), loadMine()]))
      .catch(() => {});
  };
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
      <div class="row"><a class="btn ghost sm" href="#/notifications">🔔 Thông báo</a>${u.role !== "INVESTOR" ? '<a class="btn ghost sm" href="#/list-asset">➕ Niêm yết tài sản</a>' : ""}<button class="btn ghost sm" data-action="logout">Đăng xuất</button></div></div>
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
      ${o.batches.map((b) => `<tr><td class="small">${esc(date(b.created_at))}</td><td>${esc(b.asset_code || "Ví")}</td><td>${esc(b.kind)}</td><td class="num">${num(b.line_count)}</td><td class="num">${num(b.total_amount)}</td><td>${b.status === "PAID" ? pill("ACTIVE", "Đã chi") : pill("PENDING_REVIEW", "Chờ duyệt")}</td>
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
      <div class="card"><div class="small muted">Chờ duyệt chi</div><div class="big">${vnd(o.stats.pending_payout)}</div></div>
      <div class="card"><div class="small muted">Tổng giá trị khớp lệnh</div><div class="big">${vnd(o.stats.trade_value)}</div></div>
      <div class="card"><div class="small muted">Doanh thu phí giao dịch</div><div class="big">${vnd(o.stats.fee_revenue)}</div></div></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="tab ${tab === k ? "active" : ""}" href="#/admin/${k}">${l}</a>`).join("")}</div>${body}`);
}

function previewTable(lines, amountKey = "amount") {
  return `<div class="table-wrap"><table><tr><th>Cổ đông</th><th class="num">Token</th>${amountKey === "net" ? '<th class="num">Gộp</th><th class="num">Thuế</th>' : ""}<th class="num">Nhận</th></tr>
    ${lines.map((l) => `<tr><td>${esc(l.full_name || l.user_id)}</td><td class="num">${num(l.tokens)}</td>${amountKey === "net" ? `<td class="num">${num(l.gross)}</td><td class="num">${num(l.tax)}</td>` : ""}<td class="num">${num(l[amountKey])}</td></tr>`).join("")}</table></div>`;
}

// ---------- xử lý sự kiện ----------
const forms = {
  async order(f) {
    const body = { asset_id: ts.form.assetId, side: ts.side, type: ts.type, quantity: f.qty.value.trim() };
    if (ts.type !== "MARKET") body.price = f.price.value.trim();
    if (ts.type === "STOP_LIMIT") body.stop_price = f.stop_price.value.trim();
    const o = await api("/api/exchange/orders", { method: "POST", body });
    const msg = { FILLED: "Lệnh đã khớp toàn bộ", PARTIAL: "Lệnh khớp một phần, phần còn lại chờ khớp", OPEN: "Đã đặt lệnh, đang chờ khớp", PENDING_TRIGGER: "Lệnh điều kiện đang chờ kích hoạt", CANCELLED: "Lệnh MP: không còn thanh khoản, phần chưa khớp đã hủy" }[o.status];
    toast(`${msg} (${num(o.filled_quantity)}/${num(o.quantity)})`);
    f.qty.value = "";
    await ts.reloadMine();
  },
  async alert(f) {
    await api("/api/alerts", { method: "POST", body: { asset_id: ts.form.assetId, direction: f.direction.value, price: f.price.value.trim() } });
    toast("Đã tạo cảnh báo giá");
    await ts.reloadMine();
  },
  async deposit(f) {
    const r = await api("/api/wallet/deposit", { method: "POST", body: { amount: f.amount.value.trim() } });
    closeModal();
    location.hash = `#/pay/${r.transaction_id}`;
  },
  async withdraw(f) {
    await api("/api/wallet/withdraw", { method: "POST", body: { amount: f.amount.value.trim() } });
    closeModal();
    toast("Đã gửi yêu cầu rút tiền. Tiền về tài khoản chính chủ sau khi ngân hàng duyệt chi.");
    router();
  },
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
    const r = await api("/api/orders/create", {
      method: "POST",
      body: { asset_id: currentAsset.id, token_amount: f.qty.value, from_wallet: !!f.from_wallet?.checked },
    });
    if (r.paid_from_wallet) {
      closeModal();
      toast("Đã mua bằng số dư ví. Token chờ hoàn tất gọi vốn.");
      location.hash = "#/portfolio";
      return;
    }
    location.hash = `#/pay/${r.transaction_id}`;
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
  watch(el) {
    toggleWatch(el.dataset.id);
    el.classList.toggle("on");
  },
  "board-mode"() {
    localStorage.setItem("tvn_board_full", localStorage.getItem("tvn_board_full") === "1" ? "0" : "1");
    router();
  },
  side(el) {
    ts.side = el.dataset.s;
    router();
  },
  otype(el) {
    ts.type = el.dataset.t;
    router();
  },
  async interval(el) {
    ts.interval = el.dataset.i;
    for (const b of document.querySelectorAll("#t-int button")) b.classList.toggle("on", b === el);
    await ts.reloadChart();
  },
  async otab(el) {
    ts.tab = el.dataset.k;
    for (const b of el.parentElement.querySelectorAll(".tab")) b.classList.toggle("active", b === el);
    await ts.reloadMine();
  },
  "pick-price"(el) {
    const f = ts.form?.form;
    if (!f || ts.type === "MARKET") return;
    f.price.value = el.dataset.price;
    ts.form.updateSum();
  },
  step(el) {
    const f = ts.form.form;
    const tick = Number(state.meta.fees.tick_size);
    const v = (Number(f.price.value) || Number(ts.form.m.last)) + Number(el.dataset.d) * tick;
    f.price.value = String(Math.max(tick, Math.round(v / tick) * tick));
    ts.form.updateSum();
  },
  pct(el) {
    const { form, bal, m } = ts.form;
    if (!bal) return toast("Đăng nhập để dùng tính năng này", true);
    const p = Number(el.dataset.p) / 100;
    if (ts.side === "SELL") {
      form.qty.value = String(Math.floor(Number(bal.holding.available_tokens) * p));
    } else {
      const price = ts.type === "MARKET" ? Number(m.ceiling) : Number(form.price.value) || Number(m.last);
      const per = price * (1 + Number(state.meta.fees.trade_fee_bps) / 10000);
      form.qty.value = String(Math.floor((Number(bal.cash.available) * p) / per));
    }
    ts.form.updateSum();
  },
  async "cancel-xorder"(el) {
    await api(`/api/exchange/orders/${el.dataset.id}/cancel`, { method: "POST", body: {} });
    toast("Đã hủy lệnh");
    await ts.reloadMine();
  },
  async "del-alert"(el) {
    await api(`/api/alerts/${el.dataset.id}/delete`, { method: "POST", body: {} });
    await ts.reloadMine();
  },
  deposit() {
    openModal(`<h2>Nạp tiền vào ví</h2><form data-form="deposit">
      <div class="field"><label>Số tiền (VND)</label><input name="amount" inputmode="numeric" value="10000000" required /></div>
      <div class="row">${[5, 10, 50, 100].map((x) => `<button type="button" class="chip" data-action="set-amount" data-v="${x * 1000000}">${x} triệu</button>`).join("")}</div>
      <p class="small muted">Hệ thống cấp mã VietQR định danh riêng. Tiền nằm trong tài khoản phong tỏa tại ngân hàng đối tác, được ghi có vào ví ngay khi ngân hàng báo có.</p>
      <div class="row"><button class="btn gold">Lấy mã QR</button><button type="button" class="btn ghost" data-action="close">Hủy</button></div></form>`);
  },
  "set-amount"(el) {
    el.closest("form").amount.value = el.dataset.v;
  },
  withdraw(el) {
    openModal(`<h2>Rút tiền</h2><form data-form="withdraw">
      <div class="field"><label>Số tiền (khả dụng ${vnd(el.dataset.max)})</label><input name="amount" inputmode="numeric" required /></div>
      <p class="small muted">Tiền chỉ được chuyển về tài khoản ngân hàng chính chủ đã xác thực eKYC (${esc(state.me?.bank_name || "")} ${esc(state.me?.bank_account_masked || "")}).</p>
      <div class="row"><button class="btn">Gửi yêu cầu rút</button><button type="button" class="btn ghost" data-action="close">Hủy</button></div></form>`);
  },
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
    qtyModal({ title: `Mua suất đầu tư ${a.asset_code}`, max: max.toString(), price: a.token_price, action: "buy-primary", wallet: true });
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
  const row = e.target.closest("tr[data-href]");
  if (row && !e.target.closest("[data-action]")) {
    location.hash = row.dataset.href;
    return;
  }
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
  startStream();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  router();
})();
