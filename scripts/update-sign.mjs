#!/usr/bin/env node
// 更新包 ed25519 签名工具（node:crypto 原生支持 ed25519，零依赖）。
//
// 用法：
//   node scripts/update-sign.mjs keygen [目录]          生成密钥对（默认 .signing/）
//   node scripts/update-sign.mjs sign <安装包文件>      生成 <文件>.sig（base64 单行）
//   node scripts/update-sign.mjs verify <文件> [sig]    用本地私钥自验（发版前 sanity check）
//
// 私钥约定：默认读 .signing/ed25519.key（已在 .gitignore），或环境变量 QT_UPDATE_KEY。
// 公钥以 base64（raw 32 字节）硬编码在 src-tauri/src/astral.rs 的
// UPDATE_SIGN_PUBKEY_B64 —— keygen 会打印要粘贴的那一行。
// 发布时把 <安装包>.sig 与安装包放在同一目录（应用按「下载 URL + .sig」取签名）。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY_PATH = join(ROOT, ".signing", "ed25519.key");

function b64urlToB64(s) {
  return s.replaceAll("-", "+").replaceAll("_", "/");
}

function loadPrivateKey() {
  const path = process.env.QT_UPDATE_KEY || DEFAULT_KEY_PATH;
  if (!existsSync(path)) {
    console.error(`私钥不存在：${path}`);
    console.error(`先执行：node scripts/update-sign.mjs keygen`);
    process.exit(1);
  }
  return { key: createPrivateKey(readFileSync(path, "utf8")), path };
}

function rawPublicKeyB64(privateKeyPem) {
  const jwk = createPublicKey(privateKeyPem).export({ format: "jwk" });
  // jwk.x 是 base64url 的 raw 32 字节公钥；统一转标准 base64 与 Rust 侧对齐
  return Buffer.from(b64urlToB64(jwk.x), "base64").toString("base64");
}

function keygen(outDir) {
  const dir = outDir ? join(process.cwd(), outDir) : dirname(DEFAULT_KEY_PATH);
  const keyPath = join(dir, "ed25519.key");
  if (existsSync(keyPath)) {
    console.error(`私钥已存在，拒绝覆盖：${keyPath}`);
    process.exit(1);
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  console.log(`私钥已生成：${keyPath}`);
  console.log(`公钥（raw 32 字节 base64）：${rawPublicKeyB64(privatePem)}`);
  console.log(`把公钥粘贴进 src-tauri/src/astral.rs 的 UPDATE_SIGN_PUBKEY_B64`);
}

function sign(file) {
  if (!file || !existsSync(file)) {
    console.error(`用法：node scripts/update-sign.mjs sign <安装包文件>`);
    process.exit(1);
  }
  const { key, path } = loadPrivateKey();
  const data = readFileSync(file);
  const sig = cryptoSign(null, data, key); // ed25519 不传摘要算法，固定 null
  const sigPath = `${file}.sig`;
  writeFileSync(sigPath, Buffer.from(sig).toString("base64"));
  console.log(`签名已生成：${sigPath}`);
  console.log(`（私钥：${path}；发布时与安装包同目录上传）`);
}

function verify(file, sigPath) {
  if (!file || !existsSync(file)) {
    console.error(`用法：node scripts/update-sign.mjs verify <文件> [<文件>.sig]`);
    process.exit(1);
  }
  const sigFile = sigPath || `${file}.sig`;
  if (!existsSync(sigFile)) {
    console.error(`签名文件不存在：${sigFile}`);
    process.exit(1);
  }
  const { key } = loadPrivateKey();
  // .sig 文件是 base64 文本（与 Rust 侧 verify_installer_signature_with 同口径）
  const sig = Buffer.from(readFileSync(sigFile, "utf8").trim(), "base64");
  const ok = cryptoVerify(
    null,
    readFileSync(file),
    createPublicKey(key),
    sig,
  );
  console.log(ok ? "签名验证通过" : "签名验证失败");
  process.exit(ok ? 0 : 1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "keygen") keygen(rest[0]);
else if (cmd === "sign") sign(rest[0]);
else if (cmd === "verify") verify(rest[0], rest[1]);
else {
  console.error("用法：update-sign.mjs keygen [目录] | sign <文件> | verify <文件> [sig]");
  process.exit(1);
}
