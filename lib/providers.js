const SUPPORTED_PROVIDERS = new Set(["hetzner", "hostinger"]);

export function resolveProvider(requested, fallback = "hetzner") {
  const provider = requested || fallback;
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    const err = new Error(`Unsupported DNS provider: ${provider}`);
    err.status = 400;
    throw err;
  }
  return provider;
}

export { SUPPORTED_PROVIDERS };
