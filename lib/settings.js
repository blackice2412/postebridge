import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getDataDir, getSessionSecret } from "./auth.js";

const SETTINGS_FILENAME = "settings.enc";
const ALGORITHM = "aes-256-gcm";
const VERSION = 1;

const DEFAULT_SETTINGS = {
  activeProvider: "hetzner",
  providers: {
    hetzner: { apiKey: "" },
    hostinger: { apiToken: "" },
  },
  poste: {
    baseUrl: "http://poste",
    adminEmail: "",
    adminPassword: "",
    mailHost: "",
  },
};

let settings = structuredClone(DEFAULT_SETTINGS);

function settingsFilePath() {
  return path.join(getDataDir(), SETTINGS_FILENAME);
}

async function encryptionKey() {
  const secret = await getSessionSecret();
  return crypto.createHash("sha256").update(secret).digest();
}

function mergeDefaults(value = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...value,
    providers: {
      hetzner: {
        ...DEFAULT_SETTINGS.providers.hetzner,
        ...value.providers?.hetzner,
      },
      hostinger: {
        ...DEFAULT_SETTINGS.providers.hostinger,
        ...value.providers?.hostinger,
      },
    },
    poste: {
      ...DEFAULT_SETTINGS.poste,
      ...value.poste,
    },
  };
}

async function writeSettings(value) {
  const key = await encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = {
    version: VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(settingsFilePath(), JSON.stringify(payload), { mode: 0o600 });
}

export async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsFilePath(), "utf8");
    const payload = JSON.parse(raw);
    const key = await encryptionKey();
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    settings = mergeDefaults(JSON.parse(decrypted.toString("utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    settings = structuredClone(DEFAULT_SETTINGS);
    await writeSettings(settings);
  }
  return getSettings();
}

export function getSettings() {
  return structuredClone(settings);
}

export function getPublicSettings() {
  return {
    activeProvider: settings.activeProvider,
    providers: {
      hetzner: { configured: Boolean(settings.providers.hetzner.apiKey) },
      hostinger: { configured: Boolean(settings.providers.hostinger.apiToken) },
    },
    poste: {
      configured: Boolean(
        settings.poste.baseUrl &&
          settings.poste.adminEmail &&
          settings.poste.adminPassword
      ),
      baseUrl: settings.poste.baseUrl,
      adminEmail: settings.poste.adminEmail,
      mailHost: settings.poste.mailHost,
    },
  };
}

export async function updateSettings(input = {}) {
  const next = mergeDefaults(settings);
  const activeProvider = input.activeProvider;
  if (activeProvider && !["hetzner", "hostinger"].includes(activeProvider)) {
    const err = new Error("Unsupported DNS provider");
    err.status = 400;
    throw err;
  }

  if (activeProvider) next.activeProvider = activeProvider;

  for (const [provider, secretName] of [
    ["hetzner", "apiKey"],
    ["hostinger", "apiToken"],
  ]) {
    const value = input.providers?.[provider]?.[secretName];
    if (value !== undefined) {
      next.providers[provider][secretName] = String(value).trim();
    }
  }

  for (const field of ["baseUrl", "adminEmail", "adminPassword", "mailHost"]) {
    const value = input.poste?.[field];
    if (value !== undefined) {
      next.poste[field] = String(value).trim();
    }
  }

  next.poste.baseUrl = next.poste.baseUrl.replace(/\/$/, "");
  settings = next;
  await writeSettings(settings);
  return getPublicSettings();
}
