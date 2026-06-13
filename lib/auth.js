import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import bcrypt from "bcrypt";

const USERNAME = "root";
const AUTH_FILENAME = "auth.json";

export function getDataDir() {
  return process.env.DATA_DIR || path.join(process.cwd(), "data");
}

function authFilePath() {
  return path.join(getDataDir(), AUTH_FILENAME);
}

export function generatePassword(length = 24) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_";
  const bytes = crypto.randomBytes(length);
  let password = "";
  for (let i = 0; i < length; i++) {
    password += chars[bytes[i] % chars.length];
  }
  return password;
}

function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

async function readAuthFile() {
  try {
    const raw = await fs.readFile(authFilePath(), "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeAuthFile(data) {
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(authFilePath(), JSON.stringify(data, null, 2), {
    mode: 0o600,
  });
}

export async function ensureAuth() {
  const existing = await readAuthFile();
  if (existing?.passwordHash && existing?.sessionSecret) {
    return { created: false, username: existing.username || USERNAME };
  }

  const password = generatePassword();
  const passwordHash = await bcrypt.hash(password, 12);
  const data = {
    username: USERNAME,
    passwordHash,
    sessionSecret: generateSecret(),
    createdAt: new Date().toISOString(),
  };
  await writeAuthFile(data);

  console.log("");
  console.log("══════════════════════════════════════════════════");
  console.log(" PosteBridge — first run credentials");
  console.log(` Username: ${USERNAME}`);
  console.log(` Password: ${password}`);
  console.log(" Save this password — it won't be shown again.");
  console.log(" Change it anytime: npm run change-password");
  console.log("══════════════════════════════════════════════════");
  console.log("");

  return { created: true, username: USERNAME, password };
}

export async function getSessionSecret() {
  const auth = await readAuthFile();
  if (!auth?.sessionSecret) {
    throw new Error("Auth not initialized — restart the server");
  }
  return auth.sessionSecret;
}

export async function verifyLogin(username, password) {
  const auth = await readAuthFile();
  if (!auth?.passwordHash) return false;
  if (username !== (auth.username || USERNAME)) return false;
  return bcrypt.compare(password, auth.passwordHash);
}

export async function changePassword(newPassword) {
  if (!newPassword || newPassword.length < 12) {
    throw new Error("Password must be at least 12 characters");
  }

  const auth = (await readAuthFile()) || {
    username: USERNAME,
    sessionSecret: generateSecret(),
  };

  auth.passwordHash = await bcrypt.hash(newPassword, 12);
  auth.username = USERNAME;
  auth.updatedAt = new Date().toISOString();
  if (!auth.sessionSecret) auth.sessionSecret = generateSecret();
  await writeAuthFile(auth);
  return USERNAME;
}

export { USERNAME };
