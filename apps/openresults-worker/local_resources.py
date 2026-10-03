"""Sanitized host/container measurements; no environment or path is reported."""
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import psutil
from app.services.source_requests import LocalResourceDeferred

MIB = 1024 * 1024


def limits(env=None):
    env = os.environ if env is None else env
    def number(name, default):
        raw = env.get(name, str(default))
        if not raw.isascii() or not raw.isdecimal() or not 128 <= int(raw) <= 1048576:
            raise ValueError('invalid_local_resource_limits')
        return int(raw) * MIB
    return dict(minMemoryBytes=number('WORKER_MIN_FREE_MEMORY_MB', 512),
                minTempBytes=number('WORKER_MIN_FREE_TEMP_MB', 1024),
                maxRssBytes=number('WORKER_MAX_RSS_MB', 1024))


def cgroup_available(available, root=Path('/sys/fs/cgroup'), membership=Path('/proc/self/cgroup')):
    """Apply visible memory-controller limits at every ancestor, v2 or v1."""
    if not membership.exists():
        return available
    entries = membership.read_text().splitlines()
    for line in entries:
        _, controllers, relative = line.split(':', 2)
        if controllers and 'memory' not in controllers.split(','):
            continue
        base = root if not controllers else root / 'memory'
        # Membership comes from the kernel, but never traverse outside the mount.
        relative_path = Path(relative.lstrip('/'))
        if '..' in relative_path.parts:
            raise ValueError('cgroup_measurement_invalid')
        current = base / relative_path
        # Container namespaces may show a membership path unavailable inside the
        # mounted hierarchy; the mount root still carries the container limit.
        if not current.exists():
            current = base
        while current.is_relative_to(base):
            maximum = current / ('memory.max' if not controllers else 'memory.limit_in_bytes')
            usage = current / ('memory.current' if not controllers else 'memory.usage_in_bytes')
            if maximum.exists():
                value = maximum.read_text().strip()
                if value != 'max':
                    cap = int(value)
                    consumed = int(usage.read_text().strip())
                    if cap < 0 or consumed < 0:
                        raise ValueError('cgroup_measurement_invalid')
                    available = min(available, max(0, cap - consumed))
            if current == base:
                break
            current = current.parent
    return available


def measurements():
    memory, disk, rss = None, None, None
    try:
        memory = psutil.virtual_memory().available
        if sys.platform.startswith('linux'):
            memory = cgroup_available(memory)
    except Exception:
        memory = None
    try:
        disk = min(psutil.disk_usage(tempfile.gettempdir()).free, psutil.disk_usage(os.getcwd()).free)
    except Exception:
        pass
    try:
        process = psutil.Process()
        rss = process.memory_info().rss
        for child in process.children(recursive=True):
            try:
                rss += child.memory_info().rss
            except psutil.NoSuchProcess:
                pass  # An exited child no longer consumes memory.
    except Exception:
        rss = None
    return dict(memoryAvailableBytes=memory, tempFreeBytes=disk, rssBytes=rss)


def assess(sample, configuration=None):
    configuration = limits() if configuration is None else configuration
    sample = {key: value if type(value) is int and 0 <= value <= 9007199254740991 else None
              for key, value in sample.items() if key in {'memoryAvailableBytes', 'tempFreeBytes', 'rssBytes'}}
    for key in ('memoryAvailableBytes', 'tempFreeBytes', 'rssBytes'):
        sample.setdefault(key, None)
    reason = ('local_resource_measurement_unavailable' if any(value is None for value in sample.values()) else
              'local_memory_limit' if sample['memoryAvailableBytes'] < configuration['minMemoryBytes'] or sample['rssBytes'] >= configuration['maxRssBytes'] else
              'local_disk_limit' if sample['tempFreeBytes'] < configuration['minTempBytes'] else None)
    return dict(**sample, **configuration, reason=reason, measuredAt=datetime.now(timezone.utc).isoformat())


def inspect_resources():
    return assess(measurements())


def assert_resources():
    snapshot = inspect_resources()
    if snapshot['reason']:
        raise LocalResourceDeferred(snapshot)
    return snapshot
