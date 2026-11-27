# TokenVN – Sàn số hóa & giao dịch chia nhỏ tài sản thực

MVP web-app (PWA, ưu tiên điện thoại) để **số hóa, gọi vốn chia nhỏ và giao dịch** 6 loại tài sản:

| Loại | Mã | Thu nhập chia cổ tức | Sự kiện tạm ngừng giao dịch |
|---|---|---|---|
| 🏠 Bất động sản | `VN-BDS-xxxx` | Tiền thuê (hỗ trợ Bán & thuê lại + quỹ dự phòng 6 tháng) | Thu hồi đất / quy hoạch |
| 📜 Bằng sáng chế | `VN-SC-xxxx` | Phí li-xăng | Tranh chấp / hủy hiệu lực văn bằng |
| ⚙️ Công nghệ | `VN-CN-xxxx` | Phí chuyển giao công nghệ | Tranh chấp quyền chuyển giao |
| ®️ Sản phẩm được bảo hộ SHTT | `VN-SHTT-xxxx` | Phí nhượng quyền | Tranh chấp / hủy văn bằng |
| 🎨 Tác phẩm sáng tạo | `VN-ST-xxxx` | Tiền bản quyền | Tranh chấp quyền tác giả |
| 🏺 Đồ cổ / cổ vật | `VN-DC-xxxx` | Phí trưng bày / cho thuê triển lãm | Nghi vấn nguồn gốc |

Mô hình theo bộ tài liệu đề án: **Công ty nền tảng (môi giới & công nghệ) → Công ty SPV đứng tên tài sản → Ngân hàng đối tác giữ tiền phong tỏa (Escrow) và lưu ký giấy tờ gốc**. Nền tảng không giữ tiền hộ và không đứng tên tài sản.

## Chạy thử

Yêu cầu **Node.js ≥ 22.13**. Không cần cài thư viện nào (dùng `node:sqlite`, `node:crypto`, `node:http` có sẵn).

```bash
cd apps/asset-exchange
cp .env.example .env      # tùy chọn
npm start                 # http://localhost:3000 — lần đầu tự tạo dữ liệu mẫu
npm test                  # 15 test cho sổ cái + bảo mật API
```

Tài khoản demo (mật khẩu `Demo@12345`): `admin@demo.vn`, `owner@demo.vn`, `owner2@demo.vn`, `investor@demo.vn`, `investor2@demo.vn`, `investor3@demo.vn`.

Ở môi trường dev, màn hình thanh toán có nút **"Mô phỏng ngân hàng báo có"**: server tự ký HMAC rồi đi đúng luồng webhook như ngân hàng thật. Khi `NODE_ENV=production` nút này và API của nó bị tắt.

## Tính năng

**Nhà đầu tư:** đăng ký, eKYC, xem thị trường theo loại tài sản, chi tiết tài sản (biểu đồ giá, báo cáo thu nhập P&L, hồ sơ pháp lý đã che, SPV và chứng thư lưu ký), mua sơ cấp bằng mã VietQR định danh, mua bán thứ cấp OTC, biểu quyết, danh mục (tài sản ròng, lãi/lỗ, lịch sử cổ tức), giấy xác nhận sở hữu có dấu niêm phong SHA-256 (in hoặc lưu PDF), thông báo.

**Chủ tài sản:** gửi hồ sơ niêm yết với trường thông tin và bộ hồ sơ bắt buộc riêng cho từng loại tài sản; đề xuất chuộc lại tài sản (Call Option).

**Quản trị:** duyệt eKYC, thẩm định và gán SPV, kết thúc gọi vốn (đạt Soft Cap thì mở khóa token và giải ngân cho chủ tài sản; không đạt thì hoàn 100%), chia cổ tức (xem trước, lấy từ quỹ dự phòng), tạm ngừng hoặc mở lại giao dịch, tất toán theo ma trận thoái vốn, thực hiện chuộc lại, bảng kê chi xuất CSV để duyệt thủ công trên app ngân hàng, xem nhật ký kiểm toán và kiểm tra chuỗi băm.

## Quy tắc nghiệp vụ đã cài đặt

- **Tiền và token** chỉ dùng số nguyên (SQLite INTEGER, đọc ra dạng `BigInt`); tỷ lệ dùng basis points. Không có số thực.
- **Mua sơ cấp:** khi tạo đơn, token được giữ chỗ (`reserved_tokens`) nên không thể bán vượt; đơn hết hạn sau 30 phút. Token nhận được ở trạng thái khóa cho tới khi tài sản sang tên SPV.
- **Webhook ngân hàng** `POST /api/webhooks/bank-payment`: kiểm tra HMAC-SHA256 trên body gốc (header `x-signature`). Webhook gửi lại nhiều lần chỉ được xử lý một lần. Sai số tiền thì giữ đơn để xử lý thủ công. Tiền về muộn cho đơn đã hủy thì tự lập lệnh hoàn tiền.
- **Chia cổ tức:** trừ phí sàn 5%; trích thưởng 5–10% trên phần doanh thu vượt mức cơ sở cho người có đề xuất nâng giá trị đã được thông qua. Phần còn lại chia theo tỷ lệ token, làm tròn xuống, trừ thuế TNCN 5%. Mỗi kỳ chỉ chia một lần.
- **Biểu quyết:** thông qua khi số token đồng ý **vượt 75% tổng token phát hành**. Đề xuất bị bác bỏ ngay khi phần phản đối khiến nó không thể vượt ngưỡng. Token đã dùng để biểu quyết không được rao bán cho tới khi kết thúc biểu quyết (chống dùng một token bỏ phiếu hai lần).
- **Ma trận thoái vốn:**
  - Chủ cũ nắm trên 90% (Drag-Along): bán lãi thì chia theo tỷ lệ; bán lỗ thì cổ đông nhỏ được ưu tiên nhận đủ mệnh giá gốc, chủ cũ chịu phần lỗ.
  - Cổ đông phân tán: bắt buộc có đề xuất bán toàn bộ đã được thông qua trên 75%, sau đó chia theo tỷ lệ.
- **Tạm ngừng khẩn cấp:** hủy mọi lệnh bán và đơn đang chờ, trả token về người bán, gửi thông báo mức CRITICAL cho toàn bộ cổ đông.
- **Không tự chuyển tiền:** mọi khoản chi (cổ tức, tiền bán OTC, hoàn tiền, giải ngân, tất toán) chỉ tạo **bảng kê chi** để admin duyệt thủ công trên app ngân hàng. CSV đã chống chèn công thức Excel.

## Bảo mật

- JWT HS256 (từ chối `alg: none`), mật khẩu băm bằng scrypt, giới hạn số lần đăng nhập. Vai trò luôn đọc lại từ DB; **không tin `user_id` gửi từ client** (đã có test chống IDOR). Người dùng không thể tự đăng ký làm ADMIN.
- Mọi thao tác thay đổi số dư chạy trong `BEGIN IMMEDIATE` (khóa ghi toàn DB, tuần tự hóa tương đương `SELECT … FOR UPDATE`). Có ràng buộc `CHECK` để số dư không thể âm.
- Nhật ký kiểm toán **chỉ thêm, không sửa được**: trigger chặn UPDATE/DELETE, các dòng nối với nhau bằng chuỗi băm SHA-256.
- Có CSP nghiêm ngặt (không inline script), escape toàn bộ dữ liệu khi hiển thị, giới hạn kích thước body, chống path traversal khi phục vụ file tĩnh. CCCD và số tài khoản được che khi trả về.
- Khóa bí mật chỉ nằm trong `.env`. Ở production, server không khởi động nếu thiếu `JWT_SECRET` hoặc `BANK_WEBHOOK_SECRET` (tối thiểu 32 ký tự).

## Cấu trúc

```
src/config.js      cấu hình, đọc .env
src/assetTypes.js  danh mục 6 loại tài sản (trường, hồ sơ bắt buộc, nhãn)
src/db.js          schema SQLite, transaction, audit hash-chain
src/auth.js        scrypt, JWT, HMAC
src/ledger.js      LÕI SỔ CÁI: đơn hàng, webhook, OTC, cổ tức, biểu quyết, thoái vốn, tạm ngừng
src/server.js      HTTP API + phục vụ PWA
src/seed.js        dữ liệu mẫu
public/            giao diện (HTML/CSS/JS thuần)
test/              node:test
```

## Trước khi vận hành thật (chưa có trong MVP)

- Kết nối eKYC thật (VNPT/FPT…), chữ ký số từ xa cho hợp đồng, Open API và Virtual Account của ngân hàng (thay cho nút mô phỏng), lưu trữ tệp hồ sơ.
- Chuyển sang PostgreSQL (Supabase) với Row Level Security nếu cần mở rộng nhiều máy chủ; tầng `db.js` đã tách riêng để dễ thay.
- Luật sư rà soát mô hình theo Luật Kinh doanh BĐS 2023, Luật Đất đai 2024, Luật Công nghiệp công nghệ số 2025 và Nghị quyết 05/2025/NQ-CP; với cổ vật cần thêm Luật Di sản văn hóa (bảo vật quốc gia không được mua bán), với sáng chế/nhãn hiệu cần Luật SHTT và đăng ký chuyển nhượng tại Cục SHTT. Kiểm thử xâm nhập (pentest) trước khi chạy tiền thật.
