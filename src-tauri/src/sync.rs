//! 多端同步：非对称加密 + URL 拉取
//!
//! 加密方案：混合加密
//!   - 随机生成 AES-256-GCM 密钥，加密配置明文
//!   - 用 RSA-2048-OAEP (SHA-256) 公钥加密 AES 密钥
//!   - 输出 JSON: { version, algorithm, encryptedKey, iv, ciphertext, timestamp }
//!
//! 同步流程：
//!   1. 用户配置同步 URL + 私钥（或生成密钥对）
//!   2. 手动/自动从 URL 拉取加密配置
//!   3. 用私钥解密 → 合并到本地配置

use aes_gcm::{aead::KeyInit, Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rand::RngCore;
use rsa::{
    oaep::Oaep,
    pkcs1::{DecodeRsaPrivateKey, DecodeRsaPublicKey, EncodeRsaPrivateKey, EncodeRsaPublicKey},
    pss::Pss,
    RsaPrivateKey, RsaPublicKey,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::Config;

const ALGORITHM: &str = "RSA-OAEP-SHA256+AES-256-GCM";
const PAYLOAD_VERSION: u32 = 1;

// ===== 加密 Payload 结构 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EncryptedPayload {
    pub version: u32,
    pub algorithm: String,
    /// Base64 编码的 RSA-OAEP 加密后的 AES 密钥
    pub encrypted_key: String,
    /// Base64 编码的 12 字节 IV
    pub iv: String,
    /// Base64 编码的 AES-GCM 密文（含认证标签）
    pub ciphertext: String,
    /// Unix 时间戳（秒）
    pub timestamp: i64,
}

// ===== 密钥对管理 =====

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyPair {
    /// PEM 格式私钥 (PKCS#1)
    pub private_pem: String,
    /// PEM 格式公钥 (PKCS#1)
    pub public_pem: String,
}

/// 生成 RSA-2048 密钥对
pub fn generate_keypair() -> Result<KeyPair, String> {
    let mut rng = rand::thread_rng();
    let priv_key =
        RsaPrivateKey::new(&mut rng, 2048).map_err(|e| format!("生成密钥对失败: {}", e))?;
    let pub_key = RsaPublicKey::from(&priv_key);

    let private_pem = priv_key
        .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
        .map_err(|e| format!("导出私钥失败: {}", e))?;
    let public_pem = pub_key
        .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
        .map_err(|e| format!("导出公钥失败: {}", e))?;

    Ok(KeyPair {
        private_pem: private_pem.to_string(),
        public_pem,
    })
}

/// 验证 PEM 格式的私钥是否有效
pub fn validate_private_key(pem: &str) -> Result<(), String> {
    RsaPrivateKey::from_pkcs1_pem(pem).map_err(|e| format!("私钥无效: {}", e))?;
    Ok(())
}

/// 验证 PEM 格式的公钥是否有效
pub fn validate_public_key(pem: &str) -> Result<(), String> {
    RsaPublicKey::from_pkcs1_pem(pem).map_err(|e| format!("公钥无效: {}", e))?;
    Ok(())
}

/// 从私钥 PEM 导出公钥 PEM
pub fn public_from_private(private_pem: &str) -> Result<String, String> {
    let priv_key =
        RsaPrivateKey::from_pkcs1_pem(private_pem).map_err(|e| format!("私钥无效: {}", e))?;
    let pub_key = RsaPublicKey::from(&priv_key);
    pub_key
        .to_pkcs1_pem(rsa::pkcs1::LineEnding::LF)
        .map_err(|e| format!("导出公钥失败: {}", e))
}

// ===== 加密 / 解密 =====

/// 用公钥加密配置，返回 EncryptedPayload
pub fn encrypt_config(public_pem: &str, config: &Config) -> Result<EncryptedPayload, String> {
    let pub_key =
        RsaPublicKey::from_pkcs1_pem(public_pem).map_err(|e| format!("公钥无效: {}", e))?;

    let plaintext = serde_json::to_vec(config).map_err(|e| format!("序列化失败: {}", e))?;

    // 1. 生成随机 AES-256 密钥
    let mut aes_key_bytes = vec![0u8; 32];
    rand::thread_rng().fill_bytes(&mut aes_key_bytes);
    let aes_key = Key::<Aes256Gcm>::from_slice(&aes_key_bytes);
    let cipher = Aes256Gcm::new(aes_key);

    // 2. 生成 12 字节 IV
    let mut iv_bytes = vec![0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv_bytes);
    let nonce = Nonce::from_slice(&iv_bytes);

    // 3. AES-GCM 加密
    use aes_gcm::aead::Aead;
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_ref())
        .map_err(|e| format!("AES 加密失败: {}", e))?;

    // 4. RSA-OAEP 加密 AES 密钥
    let padding = Oaep::new::<Sha256>();
    let encrypted_key = pub_key
        .encrypt(&mut rand::thread_rng(), padding, &aes_key_bytes)
        .map_err(|e| format!("RSA 加密失败: {}", e))?;

    let now = chrono_now_secs();

    Ok(EncryptedPayload {
        version: PAYLOAD_VERSION,
        algorithm: ALGORITHM.to_string(),
        encrypted_key: B64.encode(encrypted_key),
        iv: B64.encode(iv_bytes),
        ciphertext: B64.encode(ciphertext),
        timestamp: now,
    })
}

/// 用私钥解密 EncryptedPayload，返回 Config
pub fn decrypt_config(private_pem: &str, payload: &EncryptedPayload) -> Result<Config, String> {
    if payload.version != PAYLOAD_VERSION {
        return Err(format!("不支持的版本: {}", payload.version));
    }
    if payload.algorithm != ALGORITHM {
        return Err(format!("不支持的算法: {}", payload.algorithm));
    }

    let priv_key =
        RsaPrivateKey::from_pkcs1_pem(private_pem).map_err(|e| format!("私钥无效: {}", e))?;

    // 1. RSA-OAEP 解密 AES 密钥
    let encrypted_key_bytes = B64
        .decode(&payload.encrypted_key)
        .map_err(|e| format!("encrypted_key base64 解码失败: {}", e))?;
    let padding = Oaep::new::<Sha256>();
    let aes_key_bytes = priv_key
        .decrypt(padding, &encrypted_key_bytes)
        .map_err(|e| format!("RSA 解密失败: {}", e))?;

    // 2. AES-GCM 解密
    let iv_bytes = B64
        .decode(&payload.iv)
        .map_err(|e| format!("iv base64 解码失败: {}", e))?;
    let ciphertext_bytes = B64
        .decode(&payload.ciphertext)
        .map_err(|e| format!("ciphertext base64 解码失败: {}", e))?;

    let aes_key = Key::<Aes256Gcm>::from_slice(&aes_key_bytes);
    let cipher = Aes256Gcm::new(aes_key);
    let nonce = Nonce::from_slice(&iv_bytes);

    use aes_gcm::aead::Aead;
    let plaintext = cipher
        .decrypt(nonce, ciphertext_bytes.as_ref())
        .map_err(|e| format!("AES 解密失败: {}", e))?;

    let config: Config =
        serde_json::from_slice(&plaintext).map_err(|e| format!("解析配置失败: {}", e))?;

    Ok(config)
}

// ===== URL 同步 =====

/// 从指定 URL 拉取加密配置并解密
pub async fn fetch_and_decrypt(url: &str, private_pem: &str) -> Result<Config, String> {
    let client = reqwest::Client::builder()
        .user_agent("api-key-manager-sync/1.0")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("HTTP 错误: {}", resp.status()));
    }

    let body = resp.text().await.map_err(|e| format!("读取响应失败: {}", e))?;

    // 尝试解析为 EncryptedPayload
    let payload: EncryptedPayload = serde_json::from_str(&body)
        .map_err(|e| format!("解析加密 payload 失败: {}", e))?;

    decrypt_config(private_pem, &payload)
}

/// 加密配置并序列化为 JSON 字符串（用于推送到 URL 或导出）
pub fn encrypt_config_to_string(public_pem: &str, config: &Config) -> Result<String, String> {
    let payload = encrypt_config(public_pem, config)?;
    serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {}", e))
}

/// 用私钥对数据进行 RSA-PSS-SHA256 签名，返回 Base64 签名
pub fn sign_data(private_pem: &str, data: &[u8]) -> Result<String, String> {
    let priv_key = RsaPrivateKey::from_pkcs1_pem(private_pem)
        .map_err(|e| format!("私钥无效: {}", e))?;
    let pss = Pss::new::<Sha256>();
    let signature = priv_key
        .sign_with_rng(&mut rand::thread_rng(), pss, data)
        .map_err(|e| format!("签名失败: {}", e))?;
    Ok(B64.encode(signature))
}

/// 用公钥验证 RSA-PSS-SHA256 签名
pub fn verify_signature(public_pem: &str, data: &[u8], signature_b64: &str) -> Result<bool, String> {
    let pub_key = RsaPublicKey::from_pkcs1_pem(public_pem)
        .map_err(|e| format!("公钥无效: {}", e))?;
    let sig_bytes = B64
        .decode(signature_b64)
        .map_err(|e| format!("签名 base64 解码失败: {}", e))?;
    let pss = Pss::new::<Sha256>();
    match pub_key.verify(pss, data, &sig_bytes) {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}

/// 计算公钥 PEM 的 SHA-256 指纹（hex，取前 N 字符）
pub fn pubkey_fingerprint(public_pem: &str, chars: usize) -> String {
    let hash = Sha256::digest(public_pem.as_bytes());
    hash.iter().take(chars.min(32)).map(|b| format!("{:02x}", b)).collect()
}

fn chrono_now_secs() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn sample_config() -> Config {
        let mut m = BTreeMap::new();
        m.insert(
            "test-provider".into(),
            crate::config::ProviderConfig {
                base_url: "https://api.example.com".into(),
                keys: vec![crate::config::ApiKey {
                    id: "k1".into(),
                    name: "主号".into(),
                    key: "sk-test-12345".into(),
                    selected: true,
                }],
                selected_model: "gpt-4".into(),
            },
        );
        m
    }

    #[test]
    fn test_generate_keypair() {
        let kp = generate_keypair().unwrap();
        assert!(kp.private_pem.contains("BEGIN RSA PRIVATE KEY"));
        assert!(kp.public_pem.contains("BEGIN RSA PUBLIC KEY"));
    }

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let kp = generate_keypair().unwrap();
        let cfg = sample_config();

        let payload = encrypt_config(&kp.public_pem, &cfg).unwrap();
        assert_eq!(payload.version, 1);
        assert_eq!(payload.algorithm, ALGORITHM);

        let decrypted = decrypt_config(&kp.private_pem, &payload).unwrap();
        assert_eq!(decrypted.len(), 1);
        assert_eq!(
            decrypted.get("test-provider").unwrap().base_url,
            "https://api.example.com"
        );
        assert_eq!(
            decrypted.get("test-provider").unwrap().keys[0].key,
            "sk-test-12345"
        );
    }

    #[test]
    fn test_public_from_private() {
        let kp = generate_keypair().unwrap();
        let derived = public_from_private(&kp.private_pem).unwrap();
        assert_eq!(derived.trim(), kp.public_pem.trim());
    }

    #[test]
    fn test_wrong_key_fails() {
        let kp1 = generate_keypair().unwrap();
        let kp2 = generate_keypair().unwrap();
        let cfg = sample_config();

        let payload = encrypt_config(&kp1.public_pem, &cfg).unwrap();
        let result = decrypt_config(&kp2.private_pem, &payload);
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_keys() {
        let kp = generate_keypair().unwrap();
        assert!(validate_private_key(&kp.private_pem).is_ok());
        assert!(validate_public_key(&kp.public_pem).is_ok());
        assert!(validate_private_key("not a key").is_err());
        assert!(validate_public_key("not a key").is_err());
    }
}
