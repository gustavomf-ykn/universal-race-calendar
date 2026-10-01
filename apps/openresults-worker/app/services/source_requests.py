"""Task-local hooks for the shared PostgreSQL request budget, including Chromium."""
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
from typing import Awaitable, Callable

from app.models import ScraperError

class CapacityDeferred(ScraperError):
    def __init__(self, reason, resource='database'):
        if reason not in {'capacity_unconfigured', 'capacity_measurement_unavailable',
                          'capacity_database_limit', 'capacity_storage_limit'}:
            raise ValueError('capacity_control_invalid')
        self.reason = reason
        self.resource = resource
        super().__init__(reason)


class SourceBudgetDeferred(ScraperError):
    def __init__(self, retry_at: datetime):
        super().__init__('source_budget_wait')
        self.retry_at = retry_at


class SourceCircuitOpen(ScraperError):
    def __init__(self, retry_at: datetime | None = None):
        super().__init__('source_access_blocked')
        self.retry_at = retry_at


@dataclass(frozen=True)
class RequestHooks:
    before: Callable[[], Awaitable[None]]
    after: Callable[[int, str | None], Awaitable[None]]


request_hooks: ContextVar[RequestHooks | None] = ContextVar('source_request_hooks', default=None)
