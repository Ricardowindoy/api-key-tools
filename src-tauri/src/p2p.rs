use std::io::Read;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::config::Config;
use crate::sync;

/// 获取本机局域网 IPv4 地址
pub fn get_local_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| format!("获取本机 IP 失败: {}", e))
}

/// 找到一个可用的随机端口（30000-40000 之间）
pub fn find_available_port() -> Result<u16, String> {
    for port in 30000..40000 {
        if TcpListener::bind(("0.0.0.0", port)).is_ok() {
            return Ok(port);
        }
    }
    Err("找不到可用端口".into())
}

/// 生成二维码 SVG 字符串
pub fn generate_qrcode_svg(content: &str) -> Result<String, String> {
    use qrcode::QrCode;
    let code = QrCode::new(content.as_bytes())
        .map_err(|e| format!("生成二维码失败: {}", e))?;
    let size = code.width();
    let scale = 8;
    let total_size = size * scale;
    let mut svg = String::new();
    svg.push_str(&format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="{}" height="{}" viewBox="0 0 {} {}">"#,
        total_size, total_size, total_size, total_size
    ));
    svg.push_str(&format!(
        r#"<rect width="{}" height="{}" fill="white"/>"#,
        total_size, total_size
    ));
    for y in 0..size {
        for x in 0..size {
            if code[(x, y)] == qrcode::Color::Dark {
                svg.push_str(&format!(
                    r#"<rect x="{}" y="{}" width="{}" height="{}" fill="black"/>"#,
                    x * scale, y * scale, scale, scale
                ));
            }
        }
    }
    svg.push_str("</svg>");
    Ok(svg)
}

fn cors_headers() -> Vec<Header> {
    let mut h = Vec::new();
    if let Ok(header) = Header::from_bytes(b"Access-Control-Allow-Origin", b"*") {
        h.push(header);
    }
    h
}

fn json_response(body: &str, status: StatusCode) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut resp = Response::from_string(body).with_status_code(status);
    if let Ok(ct) = Header::from_bytes(b"Content-Type", b"application/json; charset=utf-8") {
        resp = resp.with_header(ct);
    }
    for h in cors_headers() {
        resp = resp.with_header(h);
    }
    resp
}

fn ok_response(body: &str) -> Response<std::io::Cursor<Vec<u8>>> {
    json_response(body, StatusCode(200))
}

/// P2P 同步服务端
pub struct P2PServer {
    /// 监听地址（ip:port）
    pub addr: String,
    running: Arc<Mutex<bool>>,
    config_json: Arc<Mutex<String>>,
    pub_key_pem: Arc<Mutex<String>>,
    received_payload: Arc<Mutex<Option<String>>>,
}

impl P2PServer {
    /// 启动 P2P 同步服务
    ///
    /// - `config_json`：分享端当前的配置 JSON（原始未加密）
    /// - `pub_key_pem`：分享端的公钥 PEM（供拉取端加密推送）
    /// - `on_push`：收到推送数据时的回调
    pub fn start<F>(
        ip: &str,
        port: u16,
        config_json: String,
        pub_key_pem: String,
        on_push: F,
    ) -> Result<Self, String>
    where
        F: Fn(String) + Send + 'static,
    {
        let addr = format!("{}:{}", ip, port);
        let server = Server::http(&addr)
            .map_err(|e| format!("启动 HTTP 服务失败 ({}): {}", addr, e))?;

        let running = Arc::new(Mutex::new(true));
        let config_json = Arc::new(Mutex::new(config_json));
        let pub_key_pem = Arc::new(Mutex::new(pub_key_pem));
        let received_payload: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        let running_clone = running.clone();
        let config_clone = config_json.clone();
        let pubkey_clone = pub_key_pem.clone();
        let received_clone = received_payload.clone();
        let on_push = Arc::new(Mutex::new(on_push));

        thread::spawn(move || {
            for mut request in server.incoming_requests() {
                if !*running_clone.lock().unwrap() {
                    let _ = request.respond(
                        Response::from_string("server stopped")
                            .with_status_code(StatusCode(503)),
                    );
                    break;
                }

                let method = request.method().clone();
                let url = request.url().to_string();

                match (method, url.as_str()) {
                    // GET /pubkey → 返回分享端的公钥
                    (Method::Get, "/pubkey") => {
                        let pk = pubkey_clone.lock().unwrap().clone();
                        let _ = request.respond(ok_response(&pk));
                    }

                    // POST /pull → 拉取端发送自己的公钥，服务端用该公钥加密配置后返回
                    (Method::Post, "/pull") => {
                        let mut caller_pubkey = String::new();
                        let _ = request.as_reader().read_to_string(&mut caller_pubkey);
                        let caller_pubkey = caller_pubkey.trim().to_string();
                        if caller_pubkey.is_empty() {
                            let _ = request.respond(json_response(
                                r#"{"error":"missing caller public key"}"#,
                                StatusCode(400),
                            ));
                            continue;
                        }
                        let cfg_str = config_clone.lock().unwrap().clone();
                        let cfg: Config = match serde_json::from_str(&cfg_str) {
                            Ok(c) => c,
                            Err(e) => {
                                let _ = request.respond(json_response(
                                    &format!(r#"{{"error":"parse config: {}"}}"#, e),
                                    StatusCode(500),
                                ));
                                continue;
                            }
                        };
                        match sync::encrypt_config_to_string(&caller_pubkey, &cfg) {
                            Ok(encrypted) => {
                                let _ = request.respond(ok_response(&encrypted));
                            }
                            Err(e) => {
                                let _ = request.respond(json_response(
                                    &format!(r#"{{"error":"encrypt: {}"}}"#, e),
                                    StatusCode(500),
                                ));
                            }
                        }
                    }

                    // POST /sync → 推送到服务端（已用服务端公钥加密的 payload）
                    (Method::Post, "/sync") => {
                        let mut body = String::new();
                        let _ = request.as_reader().read_to_string(&mut body);
                        if !body.is_empty() {
                            *received_clone.lock().unwrap() = Some(body.clone());
                            on_push.lock().unwrap()(body);
                        }
                        let _ = request.respond(ok_response(r#"{"ok":true}"#));
                    }

                    (Method::Options, _) => {
                        let mut resp = Response::empty(StatusCode(204));
                        for h in cors_headers() {
                            resp = resp.with_header(h);
                        }
                        if let Ok(h) =
                            Header::from_bytes(b"Access-Control-Allow-Methods", b"GET, POST, OPTIONS")
                        {
                            resp = resp.with_header(h);
                        }
                        if let Ok(h) =
                            Header::from_bytes(b"Access-Control-Allow-Headers", b"Content-Type")
                        {
                            resp = resp.with_header(h);
                        }
                        let _ = request.respond(resp);
                    }

                    (Method::Post, "/stop") => {
                        let _ = request.respond(ok_response(r#"{"ok":true}"#));
                        *running_clone.lock().unwrap() = false;
                        break;
                    }

                    _ => {
                        let _ = request.respond(json_response(
                            r#"{"error":"not found"}"#,
                            StatusCode(404),
                        ));
                    }
                }
            }
        });

        Ok(Self {
            addr,
            running,
            config_json,
            pub_key_pem,
            received_payload,
        })
    }

    /// 更新分享的配置 JSON（原始未加密）
    pub fn set_config_json(&self, json: String) {
        *self.config_json.lock().unwrap() = json;
    }

    /// 停止服务
    pub fn stop(&self) {
        *self.running.lock().unwrap() = false;
    }

    /// 检查服务是否还在运行
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }

    /// 获取最近收到的推送 payload
    pub fn get_received_payload(&self) -> Option<String> {
        self.received_payload.lock().unwrap().clone()
    }
}
