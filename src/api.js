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

export function withConnection(path, connectionId) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}connectionId=${encodeURIComponent(connectionId)}`;
}

export async function streamDnsCheck(payload, handlers = {}) {
  const response = await fetch("/api/dns-check/stream", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const error = new Error(data.error || response.statusText);
    error.status = response.status;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const line = part
        .split("\n")
        .find((entry) => entry.startsWith("data: "));
      if (!line) continue;
      const data = JSON.parse(line.slice(6));
      if (data.event === "check") handlers.onCheck?.(data.check);
      else if (data.event === "done") handlers.onDone?.(data);
      else if (data.event === "error") handlers.onError?.(new Error(data.error));
    }
  }
}

