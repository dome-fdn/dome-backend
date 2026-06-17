const { json, readBody, text } = require("./http.cjs");
const { broadcastNotification, IMPORTANT_INFORMATION } = require("./notifications.cjs");

function isLocalRequest(req) {
  const forwarded = req.headers["x-forwarded-for"]?.split(",")[0]?.trim();
  if (forwarded && forwarded !== "127.0.0.1" && forwarded !== "::1") {
    return false;
  }

  const address = req.socket.remoteAddress || "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.endsWith("127.0.0.1")
  );
}

function adminPageHtml(configured) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Dome Broadcast</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #04080c;
      --card: #0b1218;
      --border: #1a2733;
      --text: #e8f0f6;
      --muted: #8aa0b2;
      --accent: #7cffb2;
      --danger: #ff7a7a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
      background: radial-gradient(circle at top, #0d1720 0%, var(--bg) 55%);
      color: var(--text);
      padding: 24px;
    }
    main {
      max-width: 560px;
      margin: 0 auto;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      font-weight: 700;
    }
    p {
      margin: 0 0 20px;
      color: var(--muted);
      line-height: 1.5;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 20px;
    }
    label {
      display: block;
      margin-bottom: 16px;
      font-size: 14px;
      font-weight: 600;
    }
    input, textarea {
      width: 100%;
      margin-top: 8px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #060b10;
      color: var(--text);
      padding: 12px 14px;
      font: inherit;
    }
    textarea {
      min-height: 140px;
      resize: vertical;
    }
    button {
      width: 100%;
      border: 0;
      border-radius: 10px;
      background: var(--accent);
      color: #041008;
      font: inherit;
      font-weight: 700;
      padding: 14px 16px;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 16px;
    }
    .stat {
      background: #060b10;
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
    }
    .stat-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .stat-value {
      font-size: 22px;
      font-weight: 700;
    }
    .banner {
      margin-bottom: 16px;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #060b10;
      color: var(--muted);
      font-size: 14px;
    }
    .banner.error {
      border-color: rgba(255, 122, 122, 0.35);
      color: var(--danger);
    }
    .banner.success {
      border-color: rgba(124, 255, 178, 0.35);
      color: var(--accent);
    }
    pre {
      margin-top: 16px;
      padding: 12px;
      border-radius: 10px;
      background: #060b10;
      border: 1px solid var(--border);
      overflow: auto;
      font-size: 12px;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <main>
    <h1>Dome Broadcast</h1>
    <p>Send an Important Information push notification to all registered mobile devices.</p>

    <div id="banner" class="banner">${configured ? "Local admin only. Use SSH port forwarding to access this page." : "Notifications are not configured on this server. Set DOME_NOTIFICATIONS_SECRET and restart the backend."}</div>

    <div class="card">
      <div class="stats">
        <div class="stat">
          <div class="stat-label">Registered devices</div>
          <div class="stat-value" id="device-count">—</div>
        </div>
        <div class="stat">
          <div class="stat-label">Notification type</div>
          <div class="stat-value" style="font-size:16px;">important_information</div>
        </div>
      </div>

      <form id="broadcast-form">
        <label>
          Title
          <input id="title" name="title" maxlength="120" value="Important Information" ${configured ? "" : "disabled"} />
        </label>
        <label>
          Message
          <textarea id="body" name="body" maxlength="1000" placeholder="Write the notification message..." ${configured ? "" : "disabled"} required></textarea>
        </label>
        <button id="send-button" type="submit" ${configured ? "" : "disabled"}>Send broadcast</button>
      </form>

      <pre id="result" hidden></pre>
    </div>
  </main>

  <script>
    const form = document.getElementById("broadcast-form");
    const result = document.getElementById("result");
    const banner = document.getElementById("banner");
    const deviceCount = document.getElementById("device-count");
    const sendButton = document.getElementById("send-button");

    async function loadStats() {
      try {
        const response = await fetch("/admin/notifications/stats");
        const json = await response.json();
        if (response.ok) {
          deviceCount.textContent = String(json.registeredDevices ?? 0);
        }
      } catch (error) {
        deviceCount.textContent = "?";
      }
    }

    form?.addEventListener("submit", async (event) => {
      event.preventDefault();
      sendButton.disabled = true;
      banner.className = "banner";
      banner.textContent = "Sending...";
      result.hidden = true;

      try {
        const response = await fetch("/admin/notifications/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: document.getElementById("title").value,
            body: document.getElementById("body").value,
          }),
        });
        const json = await response.json();
        result.hidden = false;
        result.textContent = JSON.stringify(json, null, 2);

        if (!response.ok) {
          banner.className = "banner error";
          banner.textContent = json.error || "Broadcast failed.";
          return;
        }

        banner.className = "banner success";
        banner.textContent = "Sent to " + json.sent + " device(s). " + json.recipients + " registered, " + json.failed + " failed.";
        await loadStats();
      } catch (error) {
        banner.className = "banner error";
        banner.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        sendButton.disabled = false;
      }
    });

    loadStats();
  </script>
</body>
</html>`;
}

function createAdminNotificationsService(config, store) {
  return {
    async handle(req, res, path) {
      if (!path.startsWith("/admin/notifications")) {
        return null;
      }

      if (!isLocalRequest(req)) {
        return json(res, 403, { error: "admin_local_only" });
      }

      if (path === "/admin/notifications" && req.method === "GET") {
        return text(res, 200, adminPageHtml(Boolean(config.notificationsSecret)), "text/html; charset=utf-8");
      }

      if (path === "/admin/notifications/stats" && req.method === "GET") {
        const devices = await store.listEnabledPushDevices();
        const registeredDevices = devices.filter((device) =>
          device.notificationTypes.includes(IMPORTANT_INFORMATION),
        ).length;
        return json(res, 200, { ok: true, registeredDevices });
      }

      if (path === "/admin/notifications/send" && req.method === "POST") {
        if (!config.notificationsSecret) {
          return json(res, 503, { error: "notifications_not_configured" });
        }

        const body = await readBody(req);
        const result = await broadcastNotification(store, {
          type: IMPORTANT_INFORMATION,
          title: body.title,
          body: body.body,
        });
        return json(res, result.status, result.body);
      }

      return json(res, 404, { error: "not found" });
    },
  };
}

module.exports = {
  createAdminNotificationsService,
};
