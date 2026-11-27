// Dữ liệu mẫu cho môi trường demo. KHÔNG chạy trong production.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { hashPassword } from "./auth.js";

export const DEMO_PASSWORD = "Demo@12345";

export function seed(ledger, db) {
  const mkUser = (full_name, email, role, cccd, bank) => {
    let u;
    if (role === "ADMIN") {
      const id = randomUUID();
      db.run(
        "INSERT INTO users (id, full_name, email, password_hash, role) VALUES (?,?,?,?,'ADMIN')",
        id,
        full_name,
        email,
        hashPassword(DEMO_PASSWORD),
      );
      u = { id };
    } else {
      u = ledger.registerUser({ full_name, email, password: DEMO_PASSWORD, role });
    }
    ledger.submitKyc(u.id, { cccd_number: cccd, bank_account_number: bank, bank_name: "Vietcombank" });
    return u.id;
  };

  const admin = mkUser("Quản trị viên", "admin@demo.vn", "ADMIN", "001090000001", "0011000000001");
  const ownerA = mkUser("Nguyễn Văn An", "owner@demo.vn", "OWNER", "025080000002", "0011000000002");
  const ownerB = mkUser("Trần Thị Bích", "owner2@demo.vn", "OWNER", "001085000003", "0011000000003");
  const inv1 = mkUser("Lê Minh Châu", "investor@demo.vn", "INVESTOR", "001095000004", "0011000000004");
  const inv2 = mkUser("Phạm Quốc Dũng", "investor2@demo.vn", "INVESTOR", "001092000005", "0011000000005");
  const inv3 = mkUser("Hoàng Thu Hà", "investor3@demo.vn", "INVESTOR", "001098000006", "0011000000006");
  for (const id of [admin, ownerA, ownerB, inv1, inv2, inv3]) ledger.reviewKyc(admin, id, true);

  const spv1 = ledger.createSpv(admin, {
    company_name: "Công ty TNHH SPV Tài sản Số 01",
    tax_code: "0109999001",
    bank_custodian_name: "Ngân hàng Lưu ký Đối tác (demo)",
    custody_certificate_url: "/docs/custody-demo.html",
  });
  const spv2 = ledger.createSpv(admin, {
    company_name: "Công ty CP SPV Sở hữu trí tuệ 02",
    tax_code: "0109999002",
    bank_custodian_name: "Ngân hàng Lưu ký Đối tác (demo)",
    custody_certificate_url: "/docs/custody-demo.html",
  });

  const doc = (doc_type, title) => ({ doc_type, title, url: "/docs/sample-redacted.html" });
  const buy = (userId, assetId, qty) => {
    const o = ledger.createPrimaryOrder(userId, assetId, qty);
    ledger.handleBankPayment({ reference_code: o.reference_code, amount: o.amount, bank_txn_id: `SEED-${o.reference_code}` });
  };

  // 1) Bất động sản – đang gọi vốn, Bán & thuê lại 50%
  const re = ledger.submitAsset(ownerA, {
    asset_type: "REAL_ESTATE",
    title: "Lô đất thổ cư mặt đường tỉnh lộ – Việt Trì",
    description: "Đất sạch 0% nợ, chủ đất góp vốn bằng quyền sử dụng đất vào SPV và thuê lại 50% làm mặt bằng kinh doanh.",
    location: "Việt Trì, Phú Thọ",
    valuation_amount: 2_000_000_000,
    soft_cap_bps: 3000,
    is_sale_leaseback: true,
    monthly_rent_commitment: 14_000_000,
    tags: ["Đất sạch 0% nợ", "Bán & Thuê lại 50%"],
    metadata: { address: "Tỉnh lộ 2, Việt Trì, Phú Thọ", area_m2: "180", land_use_term: "Lâu dài", encumbrance: "Không" },
    documents: [doc("LAND_CERT", "Bản sao Sổ đỏ (đã che)"), doc("CUSTODY", "Chứng thư lưu ký ngân hàng"), doc("PLANNING", "Trích lục bản đồ quy hoạch")],
  });
  ledger.approveAsset(admin, re.id, { spv_id: spv1 });
  buy(inv1, re.id, 20_000);
  buy(inv2, re.id, 15_000);

  // 2) Bằng sáng chế – đang vận hành, có cổ tức & đề xuất nâng giá trị
  const pt = ledger.submitAsset(ownerB, {
    asset_type: "PATENT",
    title: "Sáng chế quy trình sấy lạnh nông sản tiết kiệm năng lượng",
    description: "Văn bằng độc quyền sáng chế đã chuyển nhượng cho SPV; đang li-xăng cho 3 nhà máy chế biến.",
    location: "Hà Nội",
    valuation_amount: 1_500_000_000,
    soft_cap_bps: 2000,
    monthly_rent_commitment: 12_000_000,
    tags: ["Văn bằng còn hiệu lực 14 năm", "3 hợp đồng li-xăng"],
    metadata: { patent_number: "1-00xxxxx", issuing_authority: "Cục Sở hữu trí tuệ", filing_date: "2020-03-15", expiry_date: "2040-03-15", ipc_class: "F26B" },
    documents: [doc("PATENT", "Văn bằng bảo hộ sáng chế"), doc("ASSIGNMENT", "Hợp đồng chuyển nhượng cho SPV"), doc("APPRAISAL", "Chứng thư thẩm định giá")],
  });
  ledger.approveAsset(admin, pt.id, { spv_id: spv2 });
  buy(inv1, pt.id, 30_000);
  buy(inv2, pt.id, 25_000);
  buy(inv3, pt.id, 20_000);
  ledger.activateAsset(admin, pt.id);
  ledger.distributeMonthlyRent(admin, pt.id, 12_000_000, { period: "2026-09" });
  ledger.distributeMonthlyRent(admin, pt.id, 12_500_000, { period: "2026-10" });
  ledger.createOtcListing(inv2, pt.id, 5_000, 11_200);
  ledger.createProposal(inv1, pt.id, {
    proposal_type: "VALUE_ADD_5_10_PERCENT",
    title: "Mở rộng li-xăng sang thị trường Campuchia",
    description: "Tôi đàm phán thêm 2 hợp đồng li-xăng; đề nghị hưởng 8% phần doanh thu tăng thêm so với mức cơ sở.",
    reward_bps: 800,
    voting_days: 14,
  });

  // 3) Công nghệ – đang gọi vốn
  const tc = ledger.submitAsset(ownerA, {
    asset_type: "TECHNOLOGY",
    title: "Công nghệ xử lý nước thải sinh hoạt bằng màng sinh học MBBR",
    description: "Bộ quy trình & thiết kế đã đăng ký chuyển giao, thu phí chuyển giao theo từng công trình.",
    location: "TP. Hồ Chí Minh",
    valuation_amount: 800_000_000,
    soft_cap_bps: 5000,
    monthly_rent_commitment: 6_000_000,
    tags: ["TRL 8", "Đã chuyển giao 5 dự án"],
    metadata: { tech_field: "Môi trường", trl: "8", transfer_certificate: "GCN-CGCN-xx/2025", licensees: "5 doanh nghiệp xây dựng" },
    documents: [doc("TECH_TRANSFER", "GCN đăng ký chuyển giao công nghệ"), doc("APPRAISAL", "Chứng thư thẩm định giá")],
  });
  ledger.approveAsset(admin, tc.id, { spv_id: spv2 });
  buy(inv3, tc.id, 10_000);

  // 4) Sản phẩm SHTT (nhãn hiệu) – đang vận hành
  const ip = ledger.submitAsset(ownerB, {
    asset_type: "IP_PRODUCT",
    title: "Nhãn hiệu & kiểu dáng gốm men lam “Lam Thủy”",
    description: "Nhãn hiệu đã đăng ký cùng kiểu dáng công nghiệp bộ sản phẩm; thu phí nhượng quyền từ 4 xưởng gốm.",
    location: "Bát Tràng, Hà Nội",
    valuation_amount: 600_000_000,
    soft_cap_bps: 2000,
    monthly_rent_commitment: 4_500_000,
    tags: ["Nhãn hiệu + Kiểu dáng CN", "Nhượng quyền 4 xưởng"],
    metadata: { ip_kind: "Nhãn hiệu, Kiểu dáng công nghiệp", registration_number: "4-0xxxxx", territory: "Việt Nam", expiry_date: "2034-06-01" },
    documents: [doc("IP_CERT", "Văn bằng bảo hộ nhãn hiệu"), doc("APPRAISAL", "Chứng thư thẩm định giá")],
  });
  ledger.approveAsset(admin, ip.id, { spv_id: spv2 });
  buy(inv1, ip.id, 8_000);
  buy(inv3, ip.id, 6_000);
  ledger.activateAsset(admin, ip.id);
  ledger.distributeMonthlyRent(admin, ip.id, 4_500_000, { period: "2026-10" });

  // 5) Tác phẩm sáng tạo – chờ thẩm định
  ledger.submitAsset(ownerA, {
    asset_type: "CREATIVE_WORK",
    title: "Bộ tranh sơn mài “Mùa nước nổi” (12 bức) và quyền khai thác bản quyền",
    description: "Quyền tài sản đối với bộ tác phẩm: in ấn, triển lãm, cấp phép hình ảnh.",
    location: "Hà Nội",
    valuation_amount: 900_000_000,
    monthly_rent_commitment: 5_000_000,
    tags: ["Đã đăng ký quyền tác giả"],
    metadata: { work_kind: "Mỹ thuật – sơn mài", author: "Họa sĩ (ẩn danh demo)", copyright_certificate: "GCN-QTG-xxxx/2024", license_channels: "Triển lãm, in ấn, NFT trưng bày" },
    documents: [doc("COPYRIGHT", "GCN đăng ký quyền tác giả")],
  });

  // 6) Đồ cổ – đang vận hành
  const at = ledger.submitAsset(ownerB, {
    asset_type: "ANTIQUE",
    title: "Bình gốm men rạn thời Nguyễn (thế kỷ XIX)",
    description: "Cổ vật đã đăng ký, có chứng thư giám định; lưu ký tại két ngân hàng, cho bảo tàng tư nhân thuê trưng bày.",
    location: "Huế",
    valuation_amount: 400_000_000,
    soft_cap_bps: 2500,
    monthly_rent_commitment: 2_500_000,
    tags: ["Đã đăng ký cổ vật", "Bảo hiểm toàn phần"],
    metadata: { era: "Thời Nguyễn, thế kỷ XIX", material: "Gốm men rạn", provenance: "Sưu tập gia đình, 3 đời sở hữu", appraisal_org: "Đơn vị giám định cổ vật (demo)", storage_vault: "Két lưu ký ngân hàng", insurance: "Bảo hiểm mỹ thuật 100% giá trị" },
    documents: [doc("ANTIQUE_REG", "Giấy chứng nhận đăng ký cổ vật"), doc("APPRAISAL", "Chứng thư giám định"), doc("CUSTODY", "Chứng thư lưu ký & bảo hiểm")],
  });
  ledger.approveAsset(admin, at.id, { spv_id: spv1 });
  buy(inv2, at.id, 6_000);
  buy(inv3, at.id, 4_000);
  ledger.activateAsset(admin, at.id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { config } = await import("./config.js");
  const { openDb } = await import("./db.js");
  const { createLedger } = await import("./ledger.js");
  const db = openDb(config.dbPath);
  if (db.get("SELECT 1 FROM users LIMIT 1")) {
    console.log("Cơ sở dữ liệu đã có dữ liệu, bỏ qua. Xóa file DB để seed lại:", config.dbPath);
  } else {
    seed(createLedger(db, config), db);
    console.log("Đã seed dữ liệu mẫu vào", config.dbPath);
  }
}
