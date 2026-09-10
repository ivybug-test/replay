"""Environment configuration, read once by the standalone app factory."""
from dataclasses import dataclass, field
import hashlib
import os
from pathlib import Path
from .oss_io.client import env_credentials


@dataclass(frozen=True)
class Settings:
    credentials: dict = field(repr=False)
    prefix: str = ''
    index_path: str = str(Path(__file__).parent / 'var' / 'executions.sqlite3')
    sync_interval: int = 60
    timeout: int = 10
    read_concurrency: int = 4
    replay_concurrency: int = 2
    live_ttl: int = 2
    object_bytes: int = 64 * 1024 * 1024
    read_cache_bytes: int = 32 * 1024 * 1024
    replay_cache_bytes: int = 64 * 1024 * 1024
    aft_path: str = str(Path(__file__).parent / 'var' / 'aft.sqlite3')
    aft_workers: int = 20
    evaluator_source_root: str | None = None

    @property
    def namespace(self):
        source = [self.credentials['bucket'], self.credentials['endpoint'], self.prefix.strip('/')]
        return hashlib.sha256('\n'.join(source).encode()).hexdigest()

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        def integer(name, default, minimum=1, maximum=1024):
            try:
                value = int(env.get(name, default))
                if not minimum <= value <= maximum:
                    raise ValueError
                return value
            except (TypeError, ValueError):
                raise ValueError(f'Invalid {name}') from None
        return cls(
            credentials=env_credentials(env), prefix=env.get('OSS_PREFIX', ''),
            index_path=env.get('REPLAY_INDEX_PATH') or cls.index_path,
            sync_interval=integer('REPLAY_SYNC_INTERVAL', 60, maximum=86400),
            timeout=integer('REPLAY_OSS_TIMEOUT', 10, maximum=120),
            read_concurrency=integer('REPLAY_READ_CONCURRENCY', 4, maximum=16),
            replay_concurrency=integer('REPLAY_CONCURRENCY', 2, maximum=8),
            live_ttl=integer('REPLAY_LIVE_TTL', 2, minimum=0, maximum=60),
            object_bytes=integer('REPLAY_OBJECT_MIB', 64, maximum=128) * 1024 * 1024,
            read_cache_bytes=integer('REPLAY_READ_CACHE_MIB', 32) * 1024 * 1024,
            replay_cache_bytes=integer('REPLAY_CACHE_MIB', 64) * 1024 * 1024,
            aft_path=env.get('REPLAY_AFT_PATH') or cls.aft_path,
            aft_workers=integer('REPLAY_AFT_WORKERS', 20, maximum=24),
            evaluator_source_root=env.get('REPLAY_EVALUATOR_SOURCE_ROOT') or None,
        )
