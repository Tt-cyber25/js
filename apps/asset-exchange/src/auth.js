import { Buffer } from "node:buffer";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, keyB64] = String(stored).split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, "base64");
  const actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

// JWT HS256 tối giản; chỉ chấp nhận đúng thuật toán HS256 (chống tấn công "alg: none").
export function signJwt(payload, secret, ttlSeconds = 60 * 60 * 8) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  try {
    const h = JSON.parse(Buffer.from(header, "base64url").toString());
    if (h.alg !== "HS256") return null;
    const expected = createHmac("sha256", secret).update(`${header}.${body}`).digest();
    const given = Buffer.from(sig, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function hmacHex(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyHmac(body, signatureHex, secret) {
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{64}$/i.test(signatureHex)) return false;
  const expected = Buffer.from(hmacHex(body, secret), "hex");
  return timingSafeEqual(expected, Buffer.from(signatureHex, "hex"));
}
