// Đặt lại mật khẩu tài khoản quản trị: node src/admin-password.js [email] [mật-khẩu-mới]
// Không truyền mật khẩu → tự sinh mật khẩu ngẫu nhiên và in ra màn hình.
import { randomBytes } from "node:crypto";
import { hashPassword } from "./auth.js";
import { config } from "./config.js";
import { openDb } from "./db.js";

const email = (process.argv[2] || "admin@demo.vn").toLowerCase();
const password = process.argv[3] || randomBytes(9).toString("base64url");
if (password.length < 8) {
  console.error("Mật khẩu tối thiểu 8 ký tự");
  process.exit(1);
}
const db = openDb(config.dbPath);
const u = db.get("SELECT id FROM users WHERE email = ? AND role = 'ADMIN'", email);
if (!u) {
  console.error(`Không tìm thấy tài khoản quản trị ${email}`);
  process.exit(1);
}
db.run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), u.id);
db.audit(null, "ADMIN_PASSWORD_RESET", "users", u.id, {});
console.log(`Mật khẩu mới của ${email}: ${password}`);
