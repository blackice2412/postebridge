const form = document.getElementById("loginForm");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      Swal.fire({ icon: "error", title: "Login failed", text: data.error || "Invalid credentials", background: "#171b26", color: "#e8ecf4", confirmButtonColor: "#d14b2a" });
      return;
    }

    const me = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!me.ok) {
      Swal.fire({
        icon: "error",
        title: "Session not saved",
        text: "Login succeeded but the session cookie was not stored. If you use HTTPS in production, set COOKIE_SECURE=true.",
        background: "#171b26",
        color: "#e8ecf4",
        confirmButtonColor: "#d14b2a",
      });
      return;
    }

    window.location.href = "/";
  } catch {
    Swal.fire({ icon: "error", title: "Connection error", text: "Could not reach the server", background: "#171b26", color: "#e8ecf4", confirmButtonColor: "#d14b2a" });
  }
});
