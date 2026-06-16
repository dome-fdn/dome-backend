const { json, readBody } = require("./http.cjs");
const { info, warn } = require("./logger.cjs");

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const IMPORTANT_INFORMATION = "important_information";
const EXPO_BATCH_SIZE = 100;

function isExpoPushToken(token) {
  return (
    typeof token === "string" &&
    /^(ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)
  );
}

function normalizeNotificationTypes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return [IMPORTANT_INFORMATION];
  }

  const normalized = [...new Set(value.filter((entry) => typeof entry === "string" && entry.trim()))];
  return normalized.length ? normalized : [IMPORTANT_INFORMATION];
}

function chunk(entries, size) {
  const chunks = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  return chunks;
}

async function sendExpoBatch(messages) {
  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    },
    body: JSON.stringify(messages),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Expo push request failed (${response.status}): ${JSON.stringify(payload)}`);
  }

  return Array.isArray(payload.data) ? payload.data : [];
}

function isAuthorized(req, config) {
  const secret = config.notificationsSecret;
  if (!secret) return false;
  return req.headers["x-dome-notifications-secret"] === secret;
}

function buildBroadcastMessage(body) {
  const type = typeof body.type === "string" ? body.type : IMPORTANT_INFORMATION;
  if (type !== IMPORTANT_INFORMATION) {
    return { error: "unsupported_notification_type" };
  }

  const title = typeof body.title === "string" && body.title.trim()
    ? body.title.trim()
    : "Important Information";
  const messageBody = typeof body.body === "string" && body.body.trim() ? body.body.trim() : "";
  if (!messageBody) {
    return { error: "missing_body" };
  }

  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : {};
  return {
    message: {
      sound: "default",
      channelId: "important",
      title,
      body: messageBody,
      data: {
        ...data,
        type,
      },
    },
    type,
  };
}

function createNotificationsService(config, store) {
  return {
    async handle(req, res, path) {
      if (path === "/v1/devices/register") {
        if (req.method !== "POST") {
          return json(res, 405, { error: "method_not_allowed" });
        }

        const body = await readBody(req);
        const token = body.token;
        const platform = body.platform;
        if (!isExpoPushToken(token)) {
          return json(res, 400, { error: "invalid_push_token" });
        }
        if (platform !== "ios" && platform !== "android") {
          return json(res, 400, { error: "invalid_platform" });
        }

        const notificationTypes = normalizeNotificationTypes(body.notificationTypes);
        await store.upsertPushDevice({ token, platform, notificationTypes });
        return json(res, 200, { ok: true });
      }

      if (path === "/v1/devices/unregister") {
        if (req.method !== "POST") {
          return json(res, 405, { error: "method_not_allowed" });
        }

        const body = await readBody(req);
        if (!isExpoPushToken(body.token)) {
          return json(res, 400, { error: "invalid_push_token" });
        }

        await store.disablePushDevices([body.token]);
        return json(res, 200, { ok: true });
      }

      if (path === "/v1/notifications/broadcast") {
        if (req.method !== "POST") {
          return json(res, 405, { error: "method_not_allowed" });
        }
        if (!config.notificationsSecret) {
          return json(res, 503, { error: "notifications_not_configured" });
        }
        if (!isAuthorized(req, config)) {
          return json(res, 401, { error: "unauthorized" });
        }

        const body = await readBody(req);
        const built = buildBroadcastMessage(body);
        if (built.error) {
          return json(res, 400, { error: built.error });
        }

        const devices = await store.listEnabledPushDevices();
        const recipients = devices.filter((device) => device.notificationTypes.includes(built.type));
        const messages = recipients.map((device) => ({
          to: device.token,
          ...built.message,
        }));

        let sent = 0;
        let failed = 0;
        const disabledTokens = [];
        const ticketIds = [];

        for (const messageBatch of chunk(messages, EXPO_BATCH_SIZE)) {
          const tickets = await sendExpoBatch(messageBatch);
          tickets.forEach((ticket, index) => {
            if (ticket.status === "ok") {
              sent += 1;
              if (ticket.id) ticketIds.push(ticket.id);
              return;
            }

            failed += 1;
            const token = messageBatch[index]?.to;
            const errorCode = ticket.details?.error;
            warn("Expo push ticket failed", { token, errorCode, message: ticket.message });
            if (token && errorCode === "DeviceNotRegistered") {
              disabledTokens.push(token);
            }
          });
        }

        if (disabledTokens.length) {
          await store.disablePushDevices(disabledTokens);
        }

        info("Broadcast notification sent", {
          type: built.type,
          recipients: recipients.length,
          sent,
          failed,
          disabled: disabledTokens.length,
        });

        return json(res, 200, {
          ok: true,
          type: built.type,
          recipients: recipients.length,
          sent,
          failed,
          disabled: disabledTokens.length,
          ticketIds,
        });
      }

      return null;
    },
  };
}

module.exports = {
  IMPORTANT_INFORMATION,
  createNotificationsService,
};
