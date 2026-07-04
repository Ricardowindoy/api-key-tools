//! P2P 局域网同步模块
//!
//! 提供临时 HTTP 服务，用于局域网内设备之间直接同步加密配置。
//! 传输的是加密后的 payload（RSA-2048-OAEP + AES-256-GCM），
//! 即使在局域网内被嗅探也无法解密。

use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Header, Method, Response, Server, StatusCode};

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

/// P2P 同步服务端
pub struct P2PServer {
    /// 监听地址（ip:port）
    pub addr: String,
    running: Arc<Mutex<bool>>,
    payload_json: Arc<Mutex<Option<String>>>,
}

impl P2PServer {
    /// 启动 P2P 同步服务
    pub fn start<F>(
        ip: &str,
        port: u16,
        initial_payload: Option<String>,
        mut on_receive: F,
    ) -> Result<Self, String>
    where
        F: FnMut(String) + Send + 'static,
    {
        let addr = format!("{}:{}", ip, port);
        let server = Server::http(&addr)
            .map_err(|e| format!("启动 HTTP 服务失败 ({}): {}", addr, e))?;

        let running = Arc::new(Mutex::new(true));
        let payload_json = Arc::new(Mutex::new(initial_payload));

        let running_clone = running.clone();
        let payload_clone = payload_json.clone();

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
                    (Method::Get, "/sync") => {
                        let payload = payload_clone.lock().unwrap().clone();
                        match payload {
                            Some(json) => {
                                let resp = Response::from_string(json)
                                    .with_header(
                                        Header::from_bytes(
                                            b"Content-Type",
                                            b"application/json; charset=utf-8",
                                        )
                                        .unwrap(),
                                    )
                                    .with_header(
                                        Header::from_bytes(
                                            b"Access-Control-Allow-Origin",
                                            b"*",
                                        )
                                        .unwrap(),
                                    );
                                let _ = request.respond(resp);
                            }
                            None => {
                                let resp = Response::from_string(
                                    r#"{"error":"no payload shared yet"}"#,
                                )
                                .with_status_code(StatusCode(404))
                                .with_header(
                                    Header::from_bytes(
                                        b"Content-Type",
                                        b"application/json",
                                    )
                                    .unwrap(),
                                )
                                .with_header(
                                    Header::from_bytes(
                                        b"Access-Control-Allow-Origin",
                                        b"*",
                                    )
                                    .unwrap(),
                                );
                                let _ = request.respond(resp);
                            }
                        }
                    }

                    (Method::Post, "/sync") => {
                        let mut body = String::new();
                        let _ = request.as_reader().read_to_string(&mut body);

                        if !body.is_empty() {
                            on_receive(body.clone());
                            *payload_clone.lock().unwrap() = Some(body);
                        }

                        let resp = Response::from_string(r#"{"ok":true}"#)
                            .with_header(
                                Header::from_bytes(b"Content-Type", b"application/json")
                                    .unwrap(),
                            )
                            .with_header(
                                Header::from_bytes(
                                    b"Access-Control-Allow-Origin",
                                    b"*",
                                )
                                .unwrap(),
                            );
                        let _ = request.respond(resp);
                    }

                    (Method::Options, _) => {
                        let resp = Response::empty(StatusCode(204))
                            .with_header(
                                Header::from_bytes(
                                    b"Access-Control-Allow-Origin",
                                    b"*",
                                )
                                .unwrap(),
                            )
                            .with_header(
                                Header::from_bytes(
                                    b"Access-Control-Allow-Methods",
                                    b"GET, POST, OPTIONS",
                                )
                                .unwrap(),
                            )
                            .with_header(
                                Header::from_bytes(
                                    b"Access-Control-Allow-Headers",
                                    b"Content-Type",
                                )
                                .unwrap(),
                            );
                        let _ = request.respond(resp);
                    }

                    (Method::Post, "/stop") => {
                        let resp = Response::from_string(r#"{"ok":true}"#)
                            .with_header(
                                Header::from_bytes(
                                    b"Access-Control-Allow-Origin",
                                    b"*",
                                )
                                .unwrap(),
                            );
                        let _ = request.respond(resp);
                        *running_clone.lock().unwrap() = false;
                        break;
                    }

                    _ => {
                        let resp = Response::from_string(r#"{"error":"not found"}"#)
                            .with_status_code(StatusCode(404))
                            .with_header(
                                Header::from_bytes(
                                    b"Access-Control-Allow-Origin",
                                    b"*",
                                )
                                .unwrap(),
                            );
                        let _ = request.respond(resp);
                    }
                }
            }
        });

        Ok(Self {
            addr,
            running,
            payload_json,
        })
    }

    /// 更新分享的加密 payload
    pub fn set_payload(&self, payload: String) {
        *self.payload_json.lock().unwrap() = Some(payload);
    }

    /// 停止服务
    pub fn stop(&self) {
        *self.running.lock().unwrap() = false;
    }

    /// 检查服务是否还在运行
    pub fn is_running(&self) -> bool {
        *self.running.lock().unwrap()
    }
}
