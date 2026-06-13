export async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

export function withProvider(path, provider) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}provider=${encodeURIComponent(provider)}`;
}
