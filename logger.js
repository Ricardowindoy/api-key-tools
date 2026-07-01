const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "app.log");

function ts() {
  return new Date().toISOString();
}

function writeLog(level, msg) {
  const line = `[${ts()}] [${level}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch (e) {
    console.error(`[${ts()}] [ERROR] Logger write failed: ${e.message}`);
  }
}

function fmt(args) {
  return args.map(a => typeof a === "object" ? JSON.stringify(a, null, 0) : String(a)).join(" ");
}

module.exports = {
  info: (...args) => writeLog("INFO", fmt(args)),
  warn: (...args) => writeLog("WARN", fmt(args)),
  error: (...args) => writeLog("ERROR", fmt(args)),
  debug: (...args) => writeLog("DEBUG", fmt(args)),
};
