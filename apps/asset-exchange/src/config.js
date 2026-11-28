import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Nạp .env đơn giản (không phụ thuộc thư viện ngoài). Biến môi trường thật luôn được ưu tiên.
const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const env = process.env;
const isProd = env.NODE_ENV === "production";

function secret(name, devFallback) {
  const v = env[name];
  if (v && v.length >= 32) return v;
  if (isProd) {
    throw new Error(`${name} phải được cấu hình (>= 32 ký tự) trong môi trường production`);
  }
  return v || devFallback;
}

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  dbPath: env.DB_PATH || join(ROOT, "data", "exchange.db"),
  jwtSecret: secret("JWT_SECRET", "dev-only-jwt-secret-do-not-use-in-production!!"),
  webhookSecret: secret("BANK_WEBHOOK_SECRET", "dev-only-bank-webhook-secret-do-not-use!!"),
  escrow: {
    bankId: env.ESCROW_BANK_ID || "970422",
    accountNo: env.ESCROW_ACCOUNT_NO || "0000000000",
    accountName: env.ESCROW_ACCOUNT_NAME || "CONG TY SPV DEMO",
  },
  platformFeeBps: BigInt(env.PLATFORM_FEE_BPS || 500),
  // Sàn khớp lệnh: phí giao dịch mỗi bên, thuế TNCN khi bán (0,1% giá trị chuyển nhượng),
  // biên độ giá quanh giá tham chiếu, bước giá
  tradeFeeBps: BigInt(env.TRADE_FEE_BPS || 15),
  sellTaxBps: BigInt(env.SELL_TAX_BPS || 10),
  bandBps: BigInt(env.PRICE_BAND_BPS || 1000),
  tickSize: BigInt(env.TICK_SIZE || 10),
  dividendTaxBps: BigInt(env.DIVIDEND_TAX_BPS || 500),
  orderTtlMinutes: Number(env.ORDER_TTL_MINUTES || 30),
  // Cho phép API mô phỏng ngân hàng (chỉ khi không phải production)
  allowBankSimulator: !isProd,
  // Đặt TRUST_PROXY=1 khi chạy sau reverse proxy / Cloudflare Tunnel
  trustProxy: env.TRUST_PROXY === "1",
};
