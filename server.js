const http = require("http");
const fs = require("fs");
const path = require("path");
const https = require("https");
const logger = require("./logger");

const BUNDLED_CONFIG_PATH = path.join(__dirname, "config.json");
let CONFIG_PATH = BUNDLED_CONFIG_PATH;
const PORT = 39871;
const PUBLIC_DIR = path.join(__dirname, "public");
let serverReadyResolve;
const serverReady = new Promise((resolve) => { serverReadyResolve = resolve; });

// ===== Config migration: old single-key → new multi-key (任意厂商) =====
function migrateConfig(raw) {
  const out = {};
  Object.keys(raw).forEach((p) => {
    const section = raw[p];
    if (!section || typeof section !== "object") return;
    const baseUrl = section.baseUrl || "";
    if (Array.isArray(section.keys)) {
      out[p] = { baseUrl, keys: section.keys, selectedModel: section.selectedModel || "" };
    } else {
      out[p] = { baseUrl, keys: section.key ? [{ id: "default", name: "默认", key: section.key || "", selected: true }] : [], selectedModel: section.selectedModel || "" };
    }
  });
  return out;
}

function defaultProvider(baseUrl) {
  return { baseUrl: baseUrl || "", keys: [] };
}

// 切换配置文件路径到 userData（打包后可写），并迁移已有配置
function setConfigPath(p) {
  CONFIG_PATH = p;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p) && fs.existsSync(BUNDLED_CONFIG_PATH)) {
      fs.copyFileSync(BUNDLED_CONFIG_PATH, p);
      logger.info("已迁移配置到:", p);
    }
  } catch (e) {
    logger.error("迁移配置失败:", e.message);
  }
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
      logger.info("配置已加载, 文件:", CONFIG_PATH);
      return migrateConfig(cfg);
    }
  } catch (e) { logger.error("读取配置失败:", e.message); }
  logger.info("使用默认配置（空）");
  return {};
}

function saveConfig(data) {
  if (!data || typeof data !== "object") throw new Error("配置格式无效");
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
  logger.info("配置已保存到:", CONFIG_PATH);
}

function getMimeType(ext) {
  const map = { ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8", ".js":"application/javascript; charset=utf-8", ".json":"application/json; charset=utf-8", ".png":"image/png", ".ico":"image/x-icon", ".svg":"image/svg+xml" };
  return map[ext] || "application/octet-stream";
}
function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  try { const c = fs.readFileSync(filePath); res.writeHead(200, { "Content-Type": getMimeType(ext) }); res.end(c); }
  catch { res.writeHead(404); res.end("Not Found"); }
}

function fetchModels(baseUrl, apiKey, provider) {
  logger.info("获取模型列表:", provider, "baseUrl:", baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const safeResolve = (val) => { if (!settled) { settled = true; resolve(val); } };
    const safeReject = (err) => { if (!settled) { settled = true; reject(err); } };
    const base = baseUrl.replace(/\/+$/, "");
    const url = new URL(`${base}/models`);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request({ hostname: url.hostname, port: url.port || (isHttps ? 443 : 80), path: url.pathname + url.search, method: "GET", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 15000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          if (res.statusCode >= 400) { let msg = `HTTP ${res.statusCode}`; try { const eb = JSON.parse(data); msg = eb.error?.message || eb.error || msg; } catch {} logger.error("获取模型失败:", provider, msg); safeReject(new Error(msg)); return; }
          const json = JSON.parse(data);
          let models;
          if (json.data && Array.isArray(json.data)) models = json.data.map(m => ({ id: m.id || m.model, description: m.description || "" }));
          else if (json.models && Array.isArray(json.models)) models = json.models.map(m => ({ id: m.id || m.model, description: m.description || "" }));
          else if (json.error) { logger.error("获取模型失败:", provider, JSON.stringify(json.error)); safeReject(new Error(json.error.message || JSON.stringify(json.error))); return; }
          else { logger.error("获取模型失败: API 返回格式异常, provider:", provider); safeReject(new Error("API 返回格式异常，不兼容 /v1/models 标准响应")); return; }
          logger.info("获取模型成功:", provider, models.length, "个模型");
          safeResolve(models);
        } catch (e) { logger.error("解析模型响应失败:", provider, data.slice(0, 200)); safeReject(new Error(`解析响应失败: ${data.slice(0, 300)}`)); }
      });
    });
    req.on("error", (e) => { if (settled) return; logger.error("网络错误:", provider, e.message); safeReject(new Error(`网络错误: ${e.message}`)); });
    req.on("timeout", () => { logger.error("请求超时:", provider); req.destroy(); safeReject(new Error("请求超时（15秒）")); });
    req.end();
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("无效的 JSON")); } });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  logger.debug(req.method, pathname);

  if (pathname === "/api/config" && req.method === "GET") { const cfg = loadConfig(); logger.info("GET /api/config providers:", Object.keys(cfg).length); res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify(cfg)); return; }
  if (pathname === "/api/config" && req.method === "POST") { try { const body = await parseBody(req); saveConfig(body); logger.info("POST /api/config 保存成功"); res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify({ ok:true })); } catch (e) { logger.error("POST /api/config 失败:", e.message); res.writeHead(400, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error:e.message })); } return; }

  // 定向更新选中项，避免全量覆写导致的数据丢失
  if (pathname === "/api/config/select" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { provider, keyId, modelId } = body;
      if (!provider) throw new Error("缺少 provider");
      const cfg = loadConfig();
      if (!cfg[provider]) cfg[provider] = { baseUrl: "", keys: [], selectedModel: "" };
      if (keyId !== undefined && keyId !== null) {
        const keys = Array.isArray(cfg[provider].keys) ? cfg[provider].keys : [];
        keys.forEach(k => { k.selected = k.id === keyId; });
      }
      if (modelId !== undefined && modelId !== null) {
        cfg[provider].selectedModel = modelId;
      }
      saveConfig(cfg);
      res.writeHead(200, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ ok:true }));
      logger.info("POST /api/config/select 已更新", provider, "选中项");
    } catch (e) {
      res.writeHead(400, { "Content-Type":"application/json" });
      res.end(JSON.stringify({ error:e.message }));
      logger.error("POST /api/config/select 失败:", e.message);
    }
    return;
  }

  if (pathname === "/api/widget" && req.method === "GET") {
    const cfg = loadConfig();
    const widget = {};
    Object.keys(cfg).forEach((p) => {
      const section = cfg[p] || {};
      const keys = Array.isArray(section.keys) ? section.keys : [];
      const selectedKey = keys.find((k) => k.selected) || keys[0] || { name: "", key: "" };
      widget[p] = {
        baseUrl: section.baseUrl || "",
        keyName: selectedKey.name || "",
        keyValue: selectedKey.key || "",
        selectedModel: section.selectedModel || "",
      };
    });
    res.writeHead(200, { "Content-Type":"application/json" });
    res.end(JSON.stringify(widget));
    logger.info("GET /api/widget 返回 widget 数据");
    return;
  }

  // POST /api/models/:provider — 从远程 API 拉取模型列表
  const modelMatch = pathname.match(/^\/api\/models\/([^/]+)$/);
  if (modelMatch && req.method === "POST") {
    const provider = modelMatch[1];
    try {
      const body = await parseBody(req);
      const apiKey = body.key || "";
      const baseUrl = body.baseUrl || "";
      if (!apiKey) { res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify({ models: [], fromBuiltin:true })); logger.info("POST /api/models/", provider, "无 Key, 返回空列表"); return; }
      if (!baseUrl) { res.writeHead(400, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error: "缺少 baseUrl" })); return; }
      const models = await fetchModels(baseUrl, apiKey, provider);
      res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify({ models }));
      logger.info("POST /api/models/", provider, "返回", models.length, "个模型");
    } catch (e) { res.writeHead(500, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error: e.message })); logger.error("POST /api/models/", provider, "错误:", e.message); }
    return;
  }

  const filePath = pathname === "/" ? path.join(PUBLIC_DIR, "index.html") : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ""));
  if (filePath.startsWith(PUBLIC_DIR)) { serveStatic(res, filePath); logger.debug("静态文件:", pathname); } else { res.writeHead(403); res.end("Forbidden"); logger.warn("禁止访问:", filePath); }
});

server.listen(PORT, () => {
  logger.info(`HTTP 服务器已启动 → http://localhost:${PORT}`);
  serverReadyResolve();
});

module.exports = { PORT, serverReady, setConfigPath };