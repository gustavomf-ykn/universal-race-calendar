"""Same SQL reservation protocol used by the TypeScript executor and API."""
import asyncio
import math
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

from app.services.source_requests import RequestHooks, SourceBudgetDeferred, SourceCircuitOpen


def retry_after_at(value: str | None):
    if not value:
        return None
    try:
        seconds = float(value)
        if not math.isfinite(seconds):
            return None
        return datetime.now(timezone.utc) + timedelta(seconds=max(0, seconds))
    except (ValueError, OverflowError):
        try:
            return parsedate_to_datetime(value).astimezone(timezone.utc)
        except (ValueError, TypeError, OverflowError):
            return None


def database_request_hooks(query, source='openresults'):
    async def before():
        while True:
            row = await asyncio.to_thread(query, 'SELECT * FROM reserve_source_request(%s)', (source,), True)
            if row['decision'] == 'allowed':
                return
            if row['decision'] == 'blocked':
                raise SourceCircuitOpen(row['retryAt'])
            if row['decision'] == 'budget' and row['retryAt']:
                raise SourceBudgetDeferred(row['retryAt'])
            if row['decision'] != 'spacing' or not row['retryAt']:
                raise RuntimeError('source_request_control_invalid')
            await asyncio.sleep(min(60, max(0.001, (row['retryAt'] - datetime.now(timezone.utc)).total_seconds())))

    async def after(status, retry_after):
        if status in (401, 403, 429):
            await asyncio.to_thread(query, 'SELECT block_source_requests(%s,%s)', (source, retry_after_at(retry_after)))

    return RequestHooks(before, after)
