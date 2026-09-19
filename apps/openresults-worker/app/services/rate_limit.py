from __future__ import annotations

import time
from collections import defaultdict, deque
from collections.abc import Callable


class SlidingWindowRateLimiter:
    """Small in-memory limiter suitable for the single-process deployment."""

    def __init__(
        self,
        limit: int,
        window_seconds: int,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.limit = max(1, limit)
        self.window_seconds = max(1, window_seconds)
        self.clock = clock
        self._requests: dict[str, deque[float]] = defaultdict(deque)

    def check(self, key: str) -> tuple[bool, int]:
        now = self.clock()
        cutoff = now - self.window_seconds
        requests = self._requests[key]
        while requests and requests[0] <= cutoff:
            requests.popleft()
        if len(requests) >= self.limit:
            retry_after = max(1, int(requests[0] + self.window_seconds - now) + 1)
            return False, retry_after
        requests.append(now)
        self._prune_empty()
        return True, 0

    def _prune_empty(self) -> None:
        if len(self._requests) < 1_000:
            return
        empty = [key for key, requests in self._requests.items() if not requests]
        for key in empty:
            self._requests.pop(key, None)
