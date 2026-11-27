# Nghiên cứu: Học gì từ app chứng khoán (VNDirect, TCBS, SSI) và sàn coin (Binance)

Mục tiêu: chọn ra những điểm mạnh đã được người dùng Việt Nam quen dùng, rồi áp dụng vào sàn giao dịch token tài sản thực (bất động sản, sáng chế, công nghệ, sở hữu trí tuệ, tác phẩm sáng tạo, đồ cổ) của TokenVN.

> Nguồn: trang hỗ trợ và mô tả sản phẩm công khai của từng công ty (danh sách cuối tài liệu), kèm hiểu biết chung về các sản phẩm này. Tính năng của các app thay đổi thường xuyên, cần kiểm tra lại trước khi dùng cho mục đích kinh doanh. TokenVN chỉ học **cơ chế và trải nghiệm**, không sao chép thương hiệu hay giao diện của bên nào.

## 1. Điểm mạnh của từng nền tảng

### VNDirect (bảng giá DBoard, app DStock/DGO)
- **Bảng giá tốc độ cao.** VNDirect công bố đã tách kênh truyền dữ liệu riêng, giúp tốc độ cập nhật bảng giá DBoard tăng gấp 3 lần.
- **Bấm vào giá trên bảng giá là đặt lệnh nhanh.** Đặt lệnh "một chạm".
- **Lệnh điều kiện (Stop Limit)** có hiệu lực tới khi được kích hoạt hoặc hết hạn.
- **Cảnh báo giá** (Alert).

### TCBS (TCInvest)
- **Nhiều sản phẩm trong một app:** cổ phiếu, trái phiếu, quỹ, chứng quyền, phái sinh.
- **Dữ liệu phân tích và định giá** cho hơn 1.350 mã, bộ lọc thông minh, bảng giá với nhiều chỉ số thời gian thực.
- **Hệ thống lệnh nhiều điều kiện** và cảnh báo thời gian thực.
- **iCopy (đầu tư sao chép):** nhà đầu tư cá nhân sao chép danh mục của nhà đầu tư có thành tích tốt; phí quản lý và phí hiệu quả thu hàng tháng.

### SSI (iBoard / iBoard Pro)
- **Lệnh điều kiện đặt được bất cứ lúc nào**, kể cả trước và sau phiên.
- **Bảng giá tùy biến:** người dùng tự tạo danh mục mã theo dõi.
- Có lệnh Stop Up/Stop Down cho thị trường phái sinh.

### Binance (sàn coin)
- **Màn hình giao dịch đầy đủ trên một trang:** biểu đồ nến, sổ lệnh có thanh độ sâu, lịch sử khớp, form đặt lệnh.
- **Nhiều loại lệnh:** giới hạn, thị trường, stop-limit, OCO, trailing stop, TWAP…
- **Nút chọn 25/50/75/100% số dư** để nhập khối lượng nhanh; hiện ngay phí và tổng tiền.
- **Giao dịch 24/7**, ví nạp/rút, danh sách mã yêu thích, chế độ xem gọn trên điện thoại.
- **Chống tự khớp lệnh** (self-trade prevention) và các quy tắc giao dịch công khai.

## 2. Những gì TokenVN đã áp dụng

| Điểm mạnh | Học từ | Cách làm trong TokenVN |
|---|---|---|
| Bảng giá thời gian thực, màu trần/sàn/tham chiếu, 3 bước giá mua/bán | VNDirect, SSI | Bảng giá cập nhật qua SSE (đẩy dữ liệu từ server), nhấp nháy khi giá đổi, có chế độ đầy đủ (24 cột) và chế độ gọn cho điện thoại |
| Danh sách mã theo dõi | SSI, Binance | Bấm ★ để theo dõi, có tab "Theo dõi" riêng |
| Bấm vào giá để đặt lệnh | VNDirect | Bấm một mức giá trên sổ lệnh là giá đó được điền vào form |
| Màn hình giao dịch một trang | Binance | Gồm biểu đồ nến (15m, 1h, 4h, 1D, MA7, khối lượng), sổ lệnh có độ sâu, khớp lệnh gần đây, form đặt lệnh, các tab lệnh chờ/lịch sử/khớp của tôi/cảnh báo |
| Lệnh LO, MP, lệnh dừng | Cả bốn | LIMIT (LO), MARKET (MP, khớp ngay, phần còn lại tự hủy), STOP_LIMIT (kích hoạt khi giá khớp chạm ngưỡng) |
| Nút 25/50/75/100% và hiện phí, thuế trước khi đặt | Binance | Có, tính theo số dư ví (khi mua) hoặc số token (khi bán) |
| Biên độ giá và bước giá | Sàn chứng khoán Việt Nam | ±10% quanh giá tham chiếu (giá khớp cuối ngày hôm trước, theo giờ Việt Nam), bước giá 10đ; chỉnh được trong `.env` |
| Phí và thuế | Chứng khoán Việt Nam | Phí 0,15% mỗi bên, thuế thu nhập cá nhân 0,1% trên giá trị bán; chỉnh được |
| Khớp lệnh liên tục, ưu tiên giá rồi thời gian | Sàn chứng khoán, Binance | Khớp tại giá của lệnh chờ sẵn; giao dịch 24/7 giống coin |
| Chống tự khớp | Binance | Lệnh chờ của chính người đặt bị hủy thay vì khớp với nhau |
| Cảnh báo giá | VNDirect, TCBS | Đặt ngưỡng "giá ≥" hoặc "giá ≤", nhận thông báo khi giá khớp chạm ngưỡng |
| Ví nạp/rút | Binance, các công ty chứng khoán | Nạp bằng mã VietQR định danh, ghi có tự động. Rút chỉ về tài khoản ngân hàng chính chủ, qua bảng kê để admin duyệt |
| Tổng tài sản ròng (NAV), lãi/lỗ, giá vốn | Các công ty chứng khoán | Màn hình "Tài sản": tiền khả dụng, tiền đang phong tỏa, giá trị token, lãi/lỗ tạm tính, cổ tức đã nhận |
| Hồ sơ doanh nghiệp | TCBS | Mỗi tài sản là một "doanh nghiệp": báo cáo thu nhập (P&L), hồ sơ pháp lý, SPV, biểu quyết |

## 3. Chưa làm (lộ trình gợi ý)

1. **Lệnh OCO và trailing stop** (Binance): lõi khớp lệnh hiện tại mở rộng được, chỉ cần thêm cách liên kết hai lệnh.
2. **Bộ lọc và chấm điểm tài sản** (TCBS): lọc theo tỷ suất thu nhập, loại tài sản, thanh khoản; điểm định giá so với chứng thư thẩm định.
3. **Đầu tư sao chép kiểu iCopy** (TCBS): **cần giấy phép quản lý danh mục**. Chỉ nên làm sau khi có tư vấn pháp lý.
4. **Phiên định kỳ ATO/ATC** của chứng khoán: hữu ích nếu tài sản có thanh khoản thấp.
5. **Nhà tạo lập thị trường** (market maker): cam kết luôn có lệnh mua và bán cho các tài sản thanh khoản thấp.
6. **Thông báo đẩy** (push notification) và đăng nhập sinh trắc học khi đóng gói thành app di động.

## 4. Lưu ý pháp lý

Khớp lệnh liên tục cho nhà đầu tư trong nước với token tài sản thực **chưa có khung pháp lý rõ ràng** tại Việt Nam. Theo đề án gốc, Nghị quyết 05/2025/NQ-CP giới hạn giai đoạn thí điểm tài sản mã hóa. Mô hình an toàn đã nêu trong đề án là chuyển nhượng **phần vốn góp trong SPV** thông qua sàn giao dịch BĐS hoặc nền tảng công nghệ, với tiền đặt trong tài khoản phong tỏa tại ngân hàng.

Phần mềm này là MVP để kiểm chứng trải nghiệm. Trước khi vận hành với tiền thật cần:
- luật sư rà soát;
- có ngân hàng giám sát tài khoản phong tỏa;
- kiểm thử xâm nhập (pentest).

## Nguồn

- VNDirect – Lệnh điều kiện Stop Limit: https://support.vndirect.com.vn/hc/en-us/articles/360002359153-Using-Conditional-Stop-Limit-Order-at-VNDIRECT
- VNDirect – Các loại lệnh: https://support.vndirect.com.vn/hc/en-us/articles/40274514153497-Types-of-Orders-at-VNDIRECT
- VNDirect ra mắt DStock (Tin nhanh chứng khoán): https://www.tinnhanhchungkhoan.vn/vndirect-ra-mat-ung-dung-dau-tu-chung-khoan-chuyen-biet-moi-dstock-post307635.html
- VNDirect tăng tốc DBoard (Tin nhanh chứng khoán): https://tinnhanhchungkhoan.vn/post-252495.html
- TCInvest trên App Store: https://apps.apple.com/vn/app/tcinvest/id1037255487
- TCBS iCopy: https://help.tcbs.com.vn/en/investment-products-faq/icopy/icopy-stock/ và https://tcbs.com.vn/icopy/chinh-sach-icopy-co-so
- SSI – Lệnh điều kiện: https://www.ssi.com.vn/en/individual-customer/conditional-orders
- SSI – Bảng giá: https://www.ssi.com.vn/en/individual-customer/price-board-app
- Binance – Các loại lệnh giao ngay: https://www.binance.com/en/support/faq/detail/8a2973eef1de429dbfad38ab878aa3eb
- Binance – Trailing stop: https://developers.binance.com/docs/binance-spot-api-docs/faqs/trailing-stop-faq
- Binance – OCO: https://www.binance.com/en/support/faq/360032605831
