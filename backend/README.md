# OSS 读取底层

当前只实现 OSS 读取模块，尚未提供 HTTP Router、执行索引、缓存或服务启动入口。
Python 3.10+，仅使用标准库；不依赖 harness 或旧 oss-replay 的代码目录。

实现参考 `osworld-runtime-harness/guest/oss_io/client.py` 和 `file.py`，保留
urllib、OSS V4 签名、凭据/时钟/传输注入、响应流和错误类型的设计。
签名单元测试使用从官方 `oss2.AuthV4` 独立生成的固定向量。

## 使用

在项目根目录中：

```python
from backend.oss_io.client import OssClient, NotModified, env_credentials
from backend.oss_io.file import read_bytes

client = OssClient(env_credentials(), timeout=10)
page = client.list_objects("your-prefix/harness/", delimiter="/", limit=100)
if page.next_cursor is not None:
    next_page = client.list_objects(
        "your-prefix/harness/", delimiter="/", limit=100, cursor=page.next_cursor,
    )

data = read_bytes(client, "your-prefix/harness/batch/batch.json", max_bytes=1024 * 1024)

# previously_seen_etag 由调用方从此前读取的 stream.etag 保存。
result = client.get_object("your-prefix/harness/batch/batch.json", if_none_match=previously_seen_etag)
if isinstance(result, NotModified):
    pass  # 使用与请求 ETag 对应的已有缓存。
else:
    with result as stream:
        etag = stream.etag
        while chunk := stream.read(64 * 1024):
            consume(chunk)  # 调用方处理数据，并负责自己的总量上限。
```

配置沿用 `OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET`、`OSS_BUCKET`、
`OSS_ENDPOINT`、`OSS_REGION`。后两项默认值与 harness 相同：河源地域的内网
HTTPS endpoint 和 `cn-heyuan`。不读取 `.env` 文件，也不回退到 VM 控制的
`ALIYUN_*` 凭据；入口程序负责加载配置，再显式创建客户端。
客户端接收完整 OSS key，根前缀和执行目录约束由后续上层负责。

## 接口与行为

- `get_object(key, if_none_match=...)`：一次流式 GET，返回 `ObjectStream`
  或 `NotModified`。流暴露 `size`、`etag`、`last_modified`、`content_type`
  和原始响应头。ETag 保留引号，时间保留 OSS 原始字符串。
- `list_objects(prefix, delimiter=..., cursor=..., limit=...)`：一次
  ListObjectsV2 请求；返回对象摘要、目录前缀和下一页游标。目录页可以只有
  `prefixes` 而没有 `objects`。保持相同筛选条件，传回游标继续查询。
- `read_bytes(client, key, max_bytes=...)`：有界完整读取；检查声明大小和
  实际读取量，成功、超限、读取失败时均关闭响应。缓存需要元信息时直接使用 GET。
- 对象不存在抛出 `OssNoSuchKey`；桶不存在、无权限、上游故障保留为
  `OssError`（HTTP 状态、OSS code 和 request ID）。网络错误和超时保留
  urllib/Python 异常；响应格式错误为 `OssProtocolError`，超限为 `OssObjectTooLarge`。
- List XML 最多读取 8 MiB，错误响应最多读取 64 KiB。分页缺游标或游标不前进
  时直接报错，不能误报历史扫描完成。
- 与 harness 一样，底层不重试、不缓存。`timeout` 是 urllib 的阻塞 I/O
  超时，并非整个请求的总时限。缓存、并发、重试、总时限由后续上层管理；
  已向调用方交付数据的流不能直接从头重试。
- 禁用环境代理与自动重定向。每个响应流必须关闭；当前 urllib 实现没有需要
  额外关闭的客户端连接池，因此不提供空的 `client.close()` 方法。

## 验证

```bash
python3 -m unittest discover -s backend/tests -v
```

测试包含签名固定向量、UTF-8/特殊字符、两页目录和对象读取、条件 GET、错误
区分、读取大小上限和关闭行为，并通过本地 HTTP 服务验证真实 urllib 请求链路。
测试不访问 OSS、不上传对象、不读取真实凭据，也不需要第三方依赖。
