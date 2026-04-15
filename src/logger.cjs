function log(level, message, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

module.exports = {
  log,
  info: (message, fields) => log("info", message, fields),
  warn: (message, fields) => log("warn", message, fields),
  error: (message, fields) => log("error", message, fields),
  debug: (message, fields) => log("debug", message, fields),
};
