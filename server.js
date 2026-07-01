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

// ===== Config migration: old single-key → new multi-key =====
function migrateConfig(raw) {
  const out = {};
  ["stepfun", "opencode"].forEach((p) => {
    const section = raw[p];
    if (!section || (!section.keys && !section.key)) {
      out[p] = { baseUrl: section?.baseUrl || defaultBaseUrl(p), keys: [], selectedModel: section?.selectedModel || "" };
      return;
    }
    if (Array.isArray(section.keys)) {
      out[p] = { baseUrl: section.baseUrl || defaultBaseUrl(p), keys: section.keys, selectedModel: section.selectedModel || "" };
    } else {
      out[p] = { baseUrl: section.baseUrl || defaultBaseUrl(p), keys: [{ id:"default", name:"默认", key: section.key || "", selected: true }], selectedModel: section.selectedModel || "" };
    }
  });
  return out;
}

function defaultProvider(p) {
  return { baseUrl: defaultBaseUrl(p), keys: [] };
}
function defaultBaseUrl(p) {
  return p === "stepfun" ? "https://api.stepfun.com/v1" : "https://opencode.ai/zen/go/v1";
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
  logger.info("使用默认配置");
  return { stepfun: defaultProvider("stepfun"), opencode: defaultProvider("opencode") };
}

function saveConfig(data) {
  if (!data || typeof data !== "object") throw new Error("配置格式无效");
  if (!data.stepfun || !data.opencode) throw new Error("配置缺少必要字段 stepfun/opencode");
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
          if (provider === "stepfun") models.forEach(m => { if (!m.description && STEPFUN_MODEL_DESC[m.id]) m.description = STEPFUN_MODEL_DESC[m.id]; });
          logger.info("获取模型成功:", provider, models.length, "个模型");
          safeResolve(models);
        } catch (e) { logger.error("解析模型响应失败:", provider, data.slice(0, 200)); safeReject(new Error(`解析响应失败: ${data.slice(0, 300)}`)); }
      });
    });
    // 超时后 req.destroy() 会触发 error 事件，settled 标志防止重复 reject 与重复日志
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

const BUILTIN_MODELS = { stepfun: [ { id:"step-3.7-flash", description:"旗舰多模态推理模型，198B MoE / 11B 激活，原生图片/视频理解，三档推理强度" }, { id:"step-3.5-flash", description:"旗舰文本推理模型，极速响应，稳定工具调用，擅长复杂项目规划与长程任务" }, { id:"step-1o-turbo-vision", description:"图像/视频理解模型，支持最多60张图片/次，适合 AI 问答、图片视频理解" }, { id:"stepaudio-2.5-realtime", description:"活人感实时语音大模型，语音↔语音交互，支持副语言感知与人设自定义" }, { id:"stepaudio-2.5-chat", description:"活人感对话大模型，仅文本返回，支持副语言感知与人设自定义" }, { id:"step-1o-audio", description:"稳定型实时语音交互，中英日粤语及四川话，单次互动最长30分钟" }, { id:"step-audio-2", description:"端到端语音模型" }, { id:"stepaudio-2.5-tts", description:"Contextual TTS 语音合成，双档语境控制，适合有声书、配音等场景" }, { id:"step-tts-2", description:"新一代文本转语音模型" }, { id:"step-tts-mini", description:"轻量 TTS，19 种音色，支持中英日语复刻" }, { id:"stepaudio-2.5-asr", description:"新一代流式 ASR 旗舰，4B MTP 架构，5 分钟音频 1 秒转写" }, { id:"stepaudio-2-asr-pro", description:"32B ASR Pro 大参数语音识别模型" }, { id:"step-asr", description:"实时/离线 ASR，支持中英文混合语音识别" }, { id:"step-2x-large", description:"文生图模型，质感真实，中英文文字生成能力强" }, { id:"step-image-edit-2", description:"文生图+图像编辑一体化，6B 以下参数，单次编辑 1-2 秒" }, { id:"step-1x-edit", description:"图像编辑模型，适合人像美化、艺术创作" } ], opencode: [ { id:"opencode/gpt-4o", description:"OpenCode GPT-4o 适配模型" }, { id:"opencode/claude-3.5-sonnet", description:"OpenCode Claude 3.5 Sonnet 适配模型" }, { id:"opencode/deepseek-v3", description:"OpenCode DeepSeek V3 适配模型" }, { id:"opencode/deepseek-r1", description:"OpenCode DeepSeek R1 推理模型" }, { id:"opencode/qwen-2.5-coder", description:"OpenCode Qwen 2.5 Coder 适配模型" } ] };
const STEPFUN_MODEL_DESC = Object.fromEntries(BUILTIN_MODELS.stepfun.map(m => [m.id, m.description]));

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;
  logger.debug(req.method, pathname);

  if (pathname === "/api/config" && req.method === "GET") { const cfg = loadConfig(); logger.info("GET /api/config  keys stepfun:", cfg.stepfun?.keys?.length, "opencode:", cfg.opencode?.keys?.length); res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify(cfg)); return; }
  if (pathname === "/api/config" && req.method === "POST") { try { const body = await parseBody(req); const keysLen = body.stepfun?.keys?.length || 0; logger.info("POST /api/config 收到的 body stepfun.keys 数量:", keysLen); saveConfig(body); logger.info("POST /api/config 保存成功"); res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify({ ok:true })); } catch (e) { logger.error("POST /api/config 失败:", e.message); res.writeHead(400, { "Content-Type":"application/json" }); res.end(JSON.stringify({ error:e.message })); } return; }

  // 定向更新选中项，避免全量覆写导致的数据丢失
  if (pathname === "/api/config/select" && req.method === "POST") {
    try {
      const body = await parseBody(req);
      const { provider, keyId, modelId } = body;
      if (!provider || (provider !== "stepfun" && provider !== "opencode")) throw new Error("无效的 provider");
      const cfg = loadConfig();
      if (!cfg[provider]) cfg[provider] = { baseUrl: defaultBaseUrl(provider), keys: [], selectedModel: "" };
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
    ["stepfun", "opencode"].forEach((p) => {
      const section = cfg[p] || {};
      const keys = Array.isArray(section.keys) ? section.keys : [];
      const selectedKey = keys.find((k) => k.selected) || keys[0] || { name: "", key: "" };
      widget[p] = {
        baseUrl: section.baseUrl || defaultBaseUrl(p),
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

  const builtinMatch = pathname.match(/^\/api\/models\/builtin\/(stepfun|opencode)$/);
  if (builtinMatch && req.method === "GET") { res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify({ models: BUILTIN_MODELS[builtinMatch[1]] || [] })); logger.info("GET /api/models/builtin 返回内置模型"); return; }

  const modelMatch = pathname.match(/^\/api\/models\/(stepfun|opencode)$/);
  if (modelMatch && req.method === "POST") {
    const provider = modelMatch[1];
    const fixedBaseUrl = provider === "stepfun" ? "https://api.stepfun.com/v1" : "https://opencode.ai/zen/go/v1";
    try {
      const body = await parseBody(req);
      const apiKey = body.key || "";
      if (!apiKey) { res.writeHead(200, { "Content-Type":"application/json" }); res.end(JSON.stringify({ models: BUILTIN_MODELS[provider] || [], fromBuiltin:true })); logger.info("POST /api/models/", provider, "无 Key, 返回内置模型"); return; }
      const models = await fetchModels(fixedBaseUrl, apiKey, provider);
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
