"""In-process fan-out of entity changes to each user's open tabs.

One asyncio queue per open notification socket, keyed by user. In-process only:
it assumes the single uvicorn worker Linkr runs with. Several workers would each
hold their own subscribers, and a change made through one would not reach a tab
connected to another — that needs a shared broker (Postgres LISTEN/NOTIFY, Redis).
"""
import asyncio
from collections import defaultdict

_subscribers: dict[int, set[asyncio.Queue]] = defaultdict(set)
# Where each user is, as last reported by one of their tabs (the focused one wins).
_contexts: dict[int, dict] = {}


def subscribe(user_id: int) -> asyncio.Queue:
    queue: asyncio.Queue = asyncio.Queue(maxsize=256)
    _subscribers[user_id].add(queue)
    return queue


def unsubscribe(user_id: int, queue: asyncio.Queue) -> None:
    _subscribers[user_id].discard(queue)
    if not _subscribers[user_id]:
        del _subscribers[user_id]
        # No tab left open: the last position no longer says where the user is.
        _contexts.pop(user_id, None)


def set_context(user_id: int, context: dict) -> None:
    _contexts[user_id] = context


def get_context(user_id: int) -> dict | None:
    return _contexts.get(user_id)


def publish(user_id: int, event: dict) -> None:
    for queue in list(_subscribers.get(user_id, ())):
        try:
            queue.put_nowait(event)
        except asyncio.QueueFull:
            # A tab that stopped reading loses events rather than stalling writers;
            # it reconciles by reloading the list when it reconnects.
            pass
