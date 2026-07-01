"""读取 config.json 中的 key，测试 DeepSeek API 连通性。"""

import json
import sys
from pathlib import Path

import requests

CONFIG_PATH = Path(__file__).parent / "config.json"
DEEPSEEK_BASE = "https://api.deepseek.com/v1"


def load_keys() -> list[dict]:
    if not CONFIG_PATH.exists():
        print(f"[错误] 找不到配置文件: {CONFIG_PATH}")
        sys.exit(1)

    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)

    keys = cfg.get("stepfun", {}).get("keys", [])
    if not keys:
        print("[提示] stepfun 下没有 key，尝试从 opencode 段读取...")
        keys = cfg.get("opencode", {}).get("keys", [])
    return keys


def test_key(api_key: str, name: str) -> bool:
    """通过调用 DeepSeek 模型列表接口验证 key 是否有效。"""
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        resp = requests.get(
            f"{DEEPSEEK_BASE}/models",
            headers=headers,
            timeout=10,
        )
        if resp.status_code == 200:
            models = resp.json().get("data", [])
            print(f"  ✅ 有效  | 可用模型数: {len(models)}")
            return True
        elif resp.status_code == 401:
            print(f"  ❌ 无效  | HTTP 401 - API Key 错误或已过期")
            return False
        elif resp.status_code == 403:
            print(f"  ❌ 无权限 | HTTP 403 - Key 无访问权限")
            return False
        elif resp.status_code == 429:
            print(f"  ⚠️  限流  | HTTP 429 - 请求过于频繁")
            return False
        else:
            detail = resp.text[:200] if resp.text else "无响应体"
            print(f"  ❓ 未知  | HTTP {resp.status_code} - {detail}")
            return False
    except requests.ConnectionError:
        print(f"  💥 网络错误 - 无法连接到 {DEEPSEEK_BASE}")
        return False
    except requests.Timeout:
        print(f"  ⏱  超时   - 请求超时 (10s)")
        return False
    except Exception as e:
        print(f"  💥 异常   - {e}")
        return False


def main():
    keys = load_keys()
    print(f"共发现 {len(keys)} 个 key\n")
    print(f"{'ID':<30} {'名称':<15} {'状态'}")
    print("-" * 70)

    valid_count = 0
    for k in keys:
        kid = k.get("id", "")
        kn = k.get("name", "")
        key = k.get("key", "")

        if not key:
            print(f"{kid:<30} {kn:<15} ⚠️  空 key，跳过")
            continue

        # 只显示 key 的前 8 位，保护隐私
        masked = key[:20] + "..." if len(key) > 20 else key
        print(f"\n[{masked}]")
        ok = test_key(key, kn)
        if ok:
            valid_count += 1

    print(f"\n{'=' * 50}")
    print(f"结果: {valid_count} / {len(keys)} 个 key 有效")


if __name__ == "__main__":
    main()
