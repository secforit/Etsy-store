from __future__ import annotations

import asyncio
import threading
import time

import pytest

from imagegen.runner import GpuBusyError, GpuRunner


class Probe:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.order: list[str] = []
        self.threads: set[str] = set()

    def job(self, name: str, seconds: float = 0.02):
        def run() -> str:
            with self.lock:
                self.active += 1
                self.max_active = max(self.max_active, self.active)
                self.order.append(f"start:{name}")
                self.threads.add(threading.current_thread().name)
            time.sleep(seconds)
            with self.lock:
                self.active -= 1
                self.order.append(f"end:{name}")
            return name

        return run


def run(coro):
    return asyncio.run(coro)


def test_jobs_run_one_at_a_time_in_order_on_one_thread() -> None:
    async def main() -> list[str]:
        runner = GpuRunner(queue_timeout_s=5)
        await runner.start()
        probe = Probe()
        try:
            results = await asyncio.gather(*(runner.run(probe.job(str(i))) for i in range(5)))
        finally:
            await runner.stop()
        assert probe.max_active == 1
        assert probe.order == [x for i in range(5) for x in (f"start:{i}", f"end:{i}")]
        assert probe.threads == {"gpu_0"}
        return results

    assert run(main()) == ["0", "1", "2", "3", "4"]


def test_waiting_too_long_is_busy_and_the_job_never_runs() -> None:
    async def main() -> None:
        runner = GpuRunner(queue_timeout_s=0.05)
        await runner.start()
        probe = Probe()
        try:
            slow = asyncio.create_task(runner.run(probe.job("slow", 0.3)))
            await asyncio.sleep(0.01)
            assert runner.busy
            with pytest.raises(GpuBusyError):
                await runner.run(probe.job("late"))
            assert await slow == "slow"
            # the abandoned job was skipped, and the runner still works
            assert await runner.run(probe.job("next")) == "next"
        finally:
            await runner.stop()
        assert "start:late" not in probe.order
        assert not runner.busy

    run(main())


def test_a_cancelled_running_job_still_finishes_before_the_next_starts() -> None:
    async def main() -> None:
        runner = GpuRunner(queue_timeout_s=5)
        await runner.start()
        probe = Probe()
        try:
            first = asyncio.create_task(runner.run(probe.job("first", 0.2)))
            await asyncio.sleep(0.02)
            first.cancel()  # e.g. the HTTP client disconnected
            second = asyncio.create_task(runner.run(probe.job("second")))
            await asyncio.sleep(0)
            waiting = asyncio.create_task(runner.run(probe.job("never", 0)))
            await asyncio.sleep(0.01)
            waiting.cancel()  # cancelled while still queued -> skipped
            assert await second == "second"
        finally:
            await runner.stop()
        assert probe.order == ["start:first", "end:first", "start:second", "end:second"]
        assert probe.max_active == 1

    run(main())


def test_queue_full_is_busy() -> None:
    async def main() -> None:
        runner = GpuRunner(queue_timeout_s=5, max_queue=1)
        await runner.start()
        probe = Probe()
        try:
            a = asyncio.create_task(runner.run(probe.job("a", 0.1)))
            await asyncio.sleep(0.01)  # a is running, queue empty
            b = asyncio.create_task(runner.run(probe.job("b")))
            await asyncio.sleep(0)  # b queued
            with pytest.raises(GpuBusyError):
                await runner.run(probe.job("c"))
            assert await a == "a" and await b == "b"
        finally:
            await runner.stop()

    run(main())


def test_exceptions_reach_the_caller_and_do_not_stop_the_runner() -> None:
    async def main() -> None:
        runner = GpuRunner(queue_timeout_s=5)
        await runner.start()
        try:

            def boom() -> None:
                raise ValueError("bad")

            with pytest.raises(ValueError, match="bad"):
                await runner.run(boom)
            assert await runner.run(lambda: 42) == 42
        finally:
            await runner.stop()

    run(main())


def test_run_requires_start() -> None:
    with pytest.raises(RuntimeError):
        run(GpuRunner(queue_timeout_s=1).run(lambda: None))
