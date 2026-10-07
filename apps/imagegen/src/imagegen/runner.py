"""Serialised GPU work.

One consumer task takes jobs from a bounded queue and runs them, one at a time, on a single dedicated thread. That is
the "single asyncio lock" of the spec, built so the lock can never be released while the GPU is still busy: a request
that is cancelled (client gone) or times out while waiting is skipped, and a job that already started always runs to
completion before the next one begins.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any


class GpuBusyError(Exception):
    """The GPU queue is full, or a request waited longer than the queue timeout without starting."""


@dataclass(eq=False)
class _Job:
    fn: Callable[[], Any]
    done: asyncio.Future[Any]
    started: asyncio.Event = field(default_factory=asyncio.Event)
    abandoned: bool = False


class GpuRunner:
    def __init__(self, queue_timeout_s: float, max_queue: int = 8) -> None:
        self._queue_timeout_s = queue_timeout_s
        self._max_queue = max_queue
        self._queue: asyncio.Queue[_Job] | None = None
        self._consumer: asyncio.Task[None] | None = None
        self._executor: ThreadPoolExecutor | None = None
        self._running: _Job | None = None

    @property
    def busy(self) -> bool:
        return self._running is not None

    async def start(self) -> None:
        if self._consumer is not None:
            return
        self._queue = asyncio.Queue(maxsize=self._max_queue)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
        self._consumer = asyncio.create_task(self._consume(), name="gpu-consumer")

    async def stop(self) -> None:
        consumer, self._consumer = self._consumer, None
        if consumer is not None:
            consumer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await consumer
        if self._executor is not None:
            # Do not wait for a running job here: process shutdown follows.
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None

    async def run(self, fn: Callable[[], Any]) -> Any:
        """Runs fn on the GPU thread after every earlier job. Raises GpuBusyError if it cannot start in time."""
        if self._queue is None or self._consumer is None:
            raise RuntimeError("GpuRunner is not started")
        loop = asyncio.get_running_loop()
        job = _Job(fn=fn, done=loop.create_future())
        # A result nobody awaits any more (client gone) must not be reported as "never retrieved".
        job.done.add_done_callback(lambda f: None if f.cancelled() else f.exception())
        try:
            self._queue.put_nowait(job)
        except asyncio.QueueFull:
            raise GpuBusyError("GPU queue is full") from None
        try:
            async with asyncio.timeout(self._queue_timeout_s):
                await job.started.wait()
        except TimeoutError:
            if not job.started.is_set():
                job.abandoned = True
                raise GpuBusyError("timed out waiting for the GPU") from None
        except asyncio.CancelledError:
            if not job.started.is_set():
                job.abandoned = True
            raise
        # Shield: if this request is cancelled now, the job still finishes before the next one starts.
        return await asyncio.shield(job.done)

    async def _consume(self) -> None:
        assert self._queue is not None
        loop = asyncio.get_running_loop()
        while True:
            job = await self._queue.get()
            try:
                if job.abandoned:
                    continue
                self._running = job
                job.started.set()
                try:
                    result = await loop.run_in_executor(self._executor, job.fn)
                except asyncio.CancelledError:
                    if not job.done.done():
                        job.done.cancel()
                    raise
                except BaseException as e:
                    if not job.done.done():
                        job.done.set_exception(e)
                else:
                    if not job.done.done():
                        job.done.set_result(result)
            finally:
                self._running = None
                self._queue.task_done()
