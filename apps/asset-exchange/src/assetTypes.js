// Danh mục loại tài sản có thể số hóa. Mỗi loại có trường thông tin riêng,
// bộ hồ sơ pháp lý bắt buộc và tên gọi dòng thu nhập tương ứng.
export const ASSET_TYPES = {
  REAL_ESTATE: {
    label: "Bất động sản",
    prefix: "BDS",
    icon: "🏠",
    incomeLabel: "Tiền thuê",
    haltLabel: "Quyết định thu hồi đất / quy hoạch",
    fields: [
      { key: "address", label: "Địa chỉ" },
      { key: "area_m2", label: "Diện tích (m²)", type: "number" },
      { key: "land_use_term", label: "Thời hạn sử dụng đất" },
      { key: "encumbrance", label: "Tình trạng nợ/thế chấp" },
    ],
    requiredDocs: ["Bản sao Sổ đỏ (đã che thông tin)", "Chứng thư lưu ký ngân hàng", "Bản đồ quy hoạch"],
  },
  PATENT: {
    label: "Bằng sáng chế",
    prefix: "SC",
    icon: "📜",
    incomeLabel: "Phí li-xăng (royalty)",
    haltLabel: "Tranh chấp / yêu cầu hủy bỏ hiệu lực văn bằng",
    fields: [
      { key: "patent_number", label: "Số văn bằng" },
      { key: "issuing_authority", label: "Cơ quan cấp" },
      { key: "filing_date", label: "Ngày nộp đơn", type: "date" },
      { key: "expiry_date", label: "Ngày hết hiệu lực", type: "date" },
      { key: "ipc_class", label: "Phân loại IPC" },
    ],
    requiredDocs: ["Văn bằng bảo hộ sáng chế", "Hợp đồng chuyển nhượng quyền sở hữu cho SPV", "Báo cáo thẩm định giá"],
  },
  TECHNOLOGY: {
    label: "Công nghệ",
    prefix: "CN",
    icon: "⚙️",
    incomeLabel: "Doanh thu chuyển giao công nghệ",
    haltLabel: "Tranh chấp quyền chuyển giao công nghệ",
    fields: [
      { key: "tech_field", label: "Lĩnh vực" },
      { key: "trl", label: "Mức độ sẵn sàng (TRL 1–9)", type: "number" },
      { key: "transfer_certificate", label: "Số GCN đăng ký chuyển giao công nghệ" },
      { key: "licensees", label: "Bên nhận chuyển giao hiện có" },
    ],
    requiredDocs: ["Giấy chứng nhận đăng ký chuyển giao công nghệ", "Hồ sơ kỹ thuật (bản tóm tắt)", "Báo cáo thẩm định giá"],
  },
  IP_PRODUCT: {
    label: "Sản phẩm được bảo hộ SHTT",
    prefix: "SHTT",
    icon: "®️",
    incomeLabel: "Phí nhượng quyền thương mại",
    haltLabel: "Tranh chấp / hủy bỏ văn bằng SHTT",
    fields: [
      { key: "ip_kind", label: "Loại bảo hộ (nhãn hiệu, kiểu dáng CN, chỉ dẫn địa lý…)" },
      { key: "registration_number", label: "Số văn bằng" },
      { key: "territory", label: "Phạm vi lãnh thổ bảo hộ" },
      { key: "expiry_date", label: "Ngày hết hiệu lực", type: "date" },
    ],
    requiredDocs: ["Văn bằng bảo hộ", "Hợp đồng chuyển nhượng cho SPV", "Báo cáo thẩm định giá"],
  },
  CREATIVE_WORK: {
    label: "Tác phẩm sáng tạo",
    prefix: "ST",
    icon: "🎨",
    incomeLabel: "Tiền bản quyền",
    haltLabel: "Tranh chấp quyền tác giả",
    fields: [
      { key: "work_kind", label: "Loại tác phẩm" },
      { key: "author", label: "Tác giả" },
      { key: "copyright_certificate", label: "Số GCN đăng ký quyền tác giả" },
      { key: "license_channels", label: "Kênh khai thác bản quyền" },
    ],
    requiredDocs: ["GCN đăng ký quyền tác giả", "Hợp đồng chuyển nhượng quyền tài sản cho SPV", "Báo cáo thẩm định giá"],
  },
  ANTIQUE: {
    label: "Đồ cổ / Cổ vật",
    prefix: "DC",
    icon: "🏺",
    incomeLabel: "Phí trưng bày / cho thuê triển lãm",
    haltLabel: "Nghi vấn nguồn gốc / tranh chấp sở hữu",
    fields: [
      { key: "era", label: "Niên đại" },
      { key: "material", label: "Chất liệu" },
      { key: "provenance", label: "Nguồn gốc / lịch sử sở hữu" },
      { key: "appraisal_org", label: "Đơn vị giám định" },
      { key: "storage_vault", label: "Nơi lưu giữ (két lưu ký)" },
      { key: "insurance", label: "Bảo hiểm" },
    ],
    requiredDocs: ["Giấy chứng nhận đăng ký cổ vật", "Chứng thư giám định", "Chứng thư lưu ký & bảo hiểm"],
  },
};

export function isAssetType(t) {
  return Object.hasOwn(ASSET_TYPES, t);
}
