# Đưa TokenVN lên mạng và lên kho ứng dụng

## Cách 0: Link công khai tạm thời từ máy tính của bạn (miễn phí, 1 phút)

Nhấp đúp `C:\TokenVN\chia-se-link.bat`. Script sẽ:
1. Tải công cụ `cloudflared` (Cloudflare Quick Tunnel, không cần tài khoản).
2. **Đổi mật khẩu admin demo** thành mật khẩu ngẫu nhiên và in ra màn hình, vì link sẽ công khai.
3. Chạy app và in ra một đường link dạng `https://xxxx.trycloudflare.com`. Mở link này trên điện thoại ở bất kỳ đâu, kể cả khi dùng 4G.

Giới hạn: link chỉ sống khi máy tính bật và cửa sổ đang mở, mỗi lần chạy link lại đổi. Chỉ dùng để demo, vì các tài khoản nhà đầu tư demo vẫn dùng mật khẩu chung `Demo@12345` (tiền ảo).

## Cách 1: Máy chủ đám mây chạy 24/7 (dùng Docker)

App có sẵn `Dockerfile`, không cần cài thư viện ngoài. Dữ liệu được lưu trong `/app/data`, **bắt buộc gắn ổ đĩa lưu trữ (volume)** vào đường dẫn này để không mất dữ liệu khi khởi động lại.

Biến môi trường bắt buộc:

| Biến | Giá trị |
|---|---|
| `JWT_SECRET` | chuỗi ngẫu nhiên ≥ 32 ký tự |
| `BANK_WEBHOOK_SECRET` | khóa bí mật chung với ngân hàng, ≥ 32 ký tự |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | tài khoản quản trị đầu tiên (mật khẩu ≥ 12 ký tự) |
| `ESCROW_BANK_ID`, `ESCROW_ACCOUNT_NO`, `ESCROW_ACCOUNT_NAME` | tài khoản phong tỏa thật |

Ở chế độ production: **không có dữ liệu demo**, **tắt nút "Mô phỏng ngân hàng"**, server từ chối khởi động nếu thiếu khóa bí mật.

**Render.com:** New → Web Service → kết nối repo GitHub → Root Directory `apps/asset-exchange` → Runtime Docker → thêm Disk gắn vào `/app/data` → nhập các biến môi trường ở trên.

**VPS (Ubuntu):**
```bash
docker build -t tokenvn apps/asset-exchange
docker run -d --restart=always -p 3000:3000 -v tokenvn-data:/app/data \
  -e JWT_SECRET=... -e BANK_WEBHOOK_SECRET=... -e ADMIN_EMAIL=... -e ADMIN_PASSWORD=... tokenvn
```
Đặt Caddy hoặc Nginx phía trước để có HTTPS cho tên miền của bạn.

## Cách 2: Đóng gói app Android (CH Play)

App đã là PWA đạt chuẩn cài đặt: có manifest, biểu tượng 192/512 (kèm bản maskable) và service worker.
1. Hoàn thành Cách 1, có tên miền HTTPS cố định.
2. Vào https://www.pwabuilder.com, nhập tên miền, chọn **Android → Generate**. Công cụ trả về file `.aab` và `assetlinks.json`.
3. Đặt `assetlinks.json` tại `public/.well-known/assetlinks.json` rồi triển khai lại, để app không hiện thanh địa chỉ.
4. Tạo tài khoản Google Play Console (25 USD), tải `.aab` lên kênh **Internal testing** trước.

iPhone: PWABuilder hoặc Capacitor đều cần **máy Mac + Xcode** và tài khoản Apple Developer (99 USD/năm).

> Lưu ý kiểm duyệt: app tài chính và đầu tư thường phải do **pháp nhân được cấp phép** đứng tên nộp. Hãy đọc chính sách hiện hành của Google Play và Apple, và chuẩn bị hồ sơ công ty trước khi nộp chính thức.
