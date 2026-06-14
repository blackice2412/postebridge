const API_BASE = "https://developers.hostinger.com";

function errorMessage(data, fallback) {
  if (typeof data?.message === "string") return data.message;
  if (typeof data?.error === "string") return data.error;
  if (data?.errors && typeof data.errors === "object") {
    return Object.values(data.errors).flat().join(", ");
  }
  return fallback;
}

export function createHostingerClient(apiToken) {
  async function request(pathname, options = {}) {
    if (!apiToken) {
      const err = new Error("Configure the Hostinger API token in Settings");
      err.status = 503;
      throw err;
    }

    const response = await fetch(`${API_BASE}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }

    if (!response.ok) {
      const err = new Error(
        `Hostinger DNS: ${errorMessage(data, `API error (${response.status})`)}`
      );
      err.status = response.status;
      err.details = data;
      throw err;
    }
    return data;
  }

  return {
    async listZones() {
      const domains = await request("/api/domains/v1/portfolio");
      return (Array.isArray(domains) ? domains : domains.data || []).map((domain) => {
        const name = domain.domain || domain.name;
        return {
          id: name,
          name,
          provider: "hostinger",
          status: domain.status || "active",
          created: domain.created_at || null,
          protection: { delete: true },
        };
      }).filter((domain) => domain.name);
    },

    async listRrsets(domain) {
      const rrsets = await request(
        `/api/dns/v1/zones/${encodeURIComponent(domain)}`
      );
      return (Array.isArray(rrsets) ? rrsets : []).map((rrset) => ({
        name: rrset.name,
        type: rrset.type,
        ttl: rrset.ttl,
        records: (rrset.records || []).map((record) => ({
          value: record.content,
          disabled: Boolean(record.is_disabled),
        })),
        protection: {
          change: ["NS", "SOA"].includes(rrset.type),
        },
      }));
    },

    async upsertRrset(domain, rrset) {
      return request(`/api/dns/v1/zones/${encodeURIComponent(domain)}`, {
        method: "PUT",
        body: JSON.stringify({
          overwrite: true,
          zone: [
            {
              name: rrset.name,
              type: rrset.type,
              ttl: rrset.ttl,
              records: rrset.records.map((record) => ({
                content: record.value,
              })),
            },
          ],
        }),
      });
    },

    async deleteRrset(domain, name, type) {
      return request(`/api/dns/v1/zones/${encodeURIComponent(domain)}`, {
        method: "DELETE",
        body: JSON.stringify({ filters: [{ name, type }] }),
      });
    },
  };
}
