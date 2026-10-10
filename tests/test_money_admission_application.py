"""Admission waits outside application-owned money sessions; accounting remains in PostgreSQL."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from treg.application import asynctasks as task_app
from treg.application.call import settle as call_settle
from treg.application.call.resolve import MarketplaceCall
from treg.application.hub import runner as hub_runner
from treg.config import get_settings
from treg.domain import money as ledger
from treg.infra import money_admission
from treg.infra.money_session import money_session
from treg.infra.db import reset_db, session_maker
from treg.models import AsyncTaskRecord, Hold, HubTool, LedgerEntry, Org, Tool
from treg.timeutil import utcnow_naive

from test_marketplace_call import EP, platform_on  # noqa: F401 - real call fixture


@pytest.fixture
async def money_db(monkeypatch):
    await reset_db()
    monkeypatch.setattr(get_settings(), "platform_margin", 0)

    async def no_archive(*_args, **_kwargs):
        pass

    monkeypatch.setattr(task_app.archive, "store_terminal_response", no_archive)


async def _fund(slug: str) -> int:
    async with session_maker() as db:
        org = Org(name=slug, slug=slug)
        db.add(org)
        await db.flush()
        org_id = org.id
        assert org_id is not None
        await ledger.grant(db, org_id, amount_micro=1_000)
        await db.commit()
        return org_id


async def _reserve(org_id: int, call_id: str, amount: int = 100) -> None:
    async with session_maker() as db:
        await ledger.reserve(db, org_id, "test.admission", amount, call_id=call_id)


def _call(org_id: int, call_id: str, reserved: int = 100) -> MarketplaceCall:
    return MarketplaceCall(
        tool=Tool(org_id=org_id, name="test", owner="test@example.invalid",
                  base_url="https://example.invalid", host="example.invalid"),
        upstream="https://example.invalid/call", consumed=set(), endpoint_id="test.admission",
        provider="test", tier="platform", cost_type="per_call", estimate_micro=reserved,
        call_id=call_id, payer_org_id=org_id, reserved_micro=reserved,
        settlement_basis={"amount": {"kind": "observed"}, "fallback_micro": reserved},
    )


class AdmissionProbe:
    """Pause the external admission boundary and observe real pool checkout/checkin events."""

    def __init__(self, monkeypatch):
        self.requested = asyncio.Event()
        self.allow = asyncio.Event()
        self.calls = []
        self.connections = set()
        self.checkouts = 0
        self.connections_on_exit = []
        self.engine = session_maker.kw["bind"].sync_engine
        event.listen(self.engine, "checkout", self.checkout)
        event.listen(self.engine, "checkin", self.checkin)
        monkeypatch.setattr(money_admission, "admit", self.admit)

    def checkout(self, connection, *_args):
        self.checkouts += 1
        self.connections.add(id(connection))

    def checkin(self, connection, *_args):
        self.connections.discard(id(connection))

    @asynccontextmanager
    async def admit(self, org_ids, *, operation):
        ids = list(org_ids)
        self.calls.append((operation, ids))
        if ids:
            self.requested.set()
            await self.allow.wait()
        try:
            yield
        finally:
            self.connections_on_exit.append(len(self.connections))

    def close(self):
        event.remove(self.engine, "checkout", self.checkout)
        event.remove(self.engine, "checkin", self.checkin)


async def _paid_case(kind: str, org_id: int):
    call_id = "admitted:price" if kind == "hub" else "admitted"
    await _reserve(org_id, call_id)
    if kind == "close":
        return call_settle._platform_settle(_call(org_id, call_id), 200, observed_override=70), (70, 70), call_id
    if kind == "deferred":
        pending = [call_settle.DeferredSettle(
            call_id, True, 70, None, "", {}, payer_org_id=org_id, reserved_micro=100)]
        return call_settle.close_deferred(pending, charge=True), 70, call_id
    if kind == "hub":
        payee = await _fund("payee")
        tool = HubTool(org_id=payee, tool_id="payee.tool", name="tool", kind="steps", summary="test")
        return hub_runner._close_price(
            tool, "admitted", 100, success=True, actual=70, payer_org_id=org_id), 70, call_id
    now = utcnow_naive()
    row = AsyncTaskRecord(
        call_id=call_id, org_id=org_id, provider="test", endpoint_id="test.admission",
        reserved_micro=100, created_at=now, next_check_at=now,
        settlement_basis={"amount": {"kind": "observed"}, "fallback_micro": 70},
    )
    async with session_maker() as db:
        db.add(row)
        await db.commit()
    return task_app._finish_terminal(row.model_copy(), "success", {}, 200, b"{}", now), "settled", call_id


@pytest.mark.parametrize("kind", ["close", "deferred", "async", "hub"])
async def test_paid_entry_waits_before_checkout_and_releases_after_session_cleanup(money_db, monkeypatch, kind):
    org_id = await _fund("payer")
    operation, expected, call_id = await _paid_case(kind, org_id)
    probe = AdmissionProbe(monkeypatch)
    task = asyncio.create_task(operation)
    try:
        await asyncio.wait_for(probe.requested.wait(), 5)
        assert probe.calls == [(kind, [org_id])]
        assert probe.checkouts == 0, "queued settlement must not consume a database connection"
        probe.allow.set()
        assert await asyncio.wait_for(task, 5) == expected
        assert probe.connections_on_exit == [0], "return the connection before releasing admission"
    finally:
        probe.allow.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        probe.close()
    async with session_maker() as db:
        assert await db.get(Hold, call_id) is None
        assert await ledger.balance_of(db, org_id) == 930
        entries = (await db.execute(select(LedgerEntry).where(
            LedgerEntry.call_id == call_id, LedgerEntry.kind == "settle"))).scalars().all()
        assert [entry.amount_micro for entry in entries] == [-70]


@pytest.mark.parametrize("status,actual", [(503, None), (200, 0), (200, -1)])
async def test_release_and_zero_settlement_do_not_wait_for_admission(money_db, monkeypatch, status, actual):
    org_id = await _fund("release")
    await _reserve(org_id, "release")
    mk = _call(org_id, "release")
    if actual == -1:
        # The provider's observed-cost parser rejects negatives; exercise the raw settlement seam.
        monkeypatch.setattr(call_settle.settlement_basis, "settle", lambda *_args: -1)
    probe = AdmissionProbe(monkeypatch)
    try:
        charged, _ = await asyncio.wait_for(call_settle._platform_settle(
            mk, status, observed_override=actual), 5)
        assert charged == 0
        assert probe.calls == [("close", [])]
        assert not probe.requested.is_set()
    finally:
        probe.close()
    async with session_maker() as db:
        assert await ledger.balance_of(db, org_id) == 1_000
        assert await db.get(Hold, "release") is None


async def test_deferred_only_admits_orgs_that_consume_blocks(money_db, monkeypatch):
    first, second = await _fund("first"), await _fund("second")
    await _reserve(first, "charged")
    await _reserve(second, "refunded")
    pending = [
        call_settle.DeferredSettle("refunded", False, None, None, "failed", {}, second, 100),
        call_settle.DeferredSettle("charged", True, 70, None, "", {}, first, 100),
    ]
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()
    try:
        assert await call_settle.close_deferred(pending, charge=True) == 70
        assert probe.calls == [("deferred", [first])]
    finally:
        probe.close()
    async with session_maker() as db:
        assert await ledger.balance_of(db, first) == 930
        assert await ledger.balance_of(db, second) == 1_000
        assert await db.get(Hold, "charged") is None
        assert await db.get(Hold, "refunded") is None


async def test_cancellation_during_gate_wait_keeps_hold_for_existing_compensation(money_db, monkeypatch):
    org_id = await _fund("cancelled")
    await _reserve(org_id, "cancelled")
    mk = _call(org_id, "cancelled")
    probe = AdmissionProbe(monkeypatch)
    task = asyncio.create_task(call_settle._platform_settle(mk, 200, observed_override=70))
    try:
        await asyncio.wait_for(probe.requested.wait(), 5)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert probe.checkouts == 0
        await call_settle._finish_cancelled_call(None, mk, "cancelled")
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        probe.close()
    async with session_maker() as db:
        assert await ledger.balance_of(db, org_id) == 1_000
        assert await db.get(Hold, "cancelled") is None
        kinds = (await db.execute(select(LedgerEntry.kind).where(
            LedgerEntry.call_id == "cancelled"))).scalars().all()
        assert kinds.count("release") == 1 and "settle" not in kinds


async def test_admission_survives_commit_until_session_cleanup(money_db, monkeypatch):
    org_id = await _fund("committed")
    await _reserve(org_id, "committed")
    mk = _call(org_id, "committed")
    committed, never = asyncio.Event(), asyncio.Event()
    original = AsyncSession.commit

    async def after_commit(db):
        await original(db)
        committed.set()
        await never.wait()

    monkeypatch.setattr(AsyncSession, "commit", after_commit)
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()
    task = asyncio.create_task(call_settle._platform_settle(mk, 200, observed_override=70))
    try:
        await asyncio.wait_for(committed.wait(), 5)
        assert probe.connections_on_exit == []
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert probe.connections_on_exit == [0]
        monkeypatch.setattr(AsyncSession, "commit", original)
        await call_settle._finish_cancelled_call(None, mk, "committed")
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        probe.close()
    async with session_maker() as db:
        assert await ledger.balance_of(db, org_id) == 930
        assert await db.get(Hold, "committed") is None
        entries = (await db.execute(select(LedgerEntry).where(
            LedgerEntry.call_id == "committed", LedgerEntry.kind.in_(["settle", "release"])))).scalars().all()
        assert [(entry.kind, entry.amount_micro) for entry in entries] == [("settle", -70)]


async def test_real_call_carries_reserved_payer_to_admission(clients, platform_on, monkeypatch):
    org_id = (await clients.get("/orgs")).json()[0]["org_id"]
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()
    try:
        response = await clients.get(f"/call/{EP}?aweme_id=admission")
        assert response.status_code == 200, response.text
        assert probe.calls == [("close", [org_id])]
    finally:
        probe.close()


async def test_deferred_child_keeps_payer_until_parent_closes(money_db, monkeypatch):
    org_id = await _fund("deferred-child")
    await _reserve(org_id, "child")
    mk = _call(org_id, "child")
    mk.settlement_basis["fallback_micro"] = 70
    mk.deferred = []
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()
    try:
        assert (await call_settle._platform_settle(mk, 200))[0] == 70
        assert probe.calls == [], "children must not own admission while the parent still runs upstream"
        assert len(mk.deferred) == 1
        assert mk.deferred[0].payer_org_id == org_id
        assert mk.deferred[0].reserved_micro == 100
        assert await call_settle.close_deferred(mk.deferred, charge=True) == 70
        assert probe.calls == [("deferred", [org_id])]
    finally:
        probe.close()


@pytest.mark.parametrize("awaiting_usage", [True, False])
async def test_async_usage_wait_and_failure_bypass_paid_admission(money_db, monkeypatch, awaiting_usage):
    org_id = await _fund("async-non-consumer")
    call_id = "async-non-consumer"
    await _reserve(org_id, call_id)
    now = utcnow_naive()
    row = AsyncTaskRecord(
        call_id=call_id, org_id=org_id, provider="test", endpoint_id="test.admission",
        reserved_micro=100, created_at=now, next_check_at=now,
        settlement_basis={"amount": {"kind": "usage", "path": "usage.cost", "unit": "usd"},
                          "reserve_micro": 100},
    )
    async with session_maker() as db:
        db.add(row)
        await db.commit()
    probe = AdmissionProbe(monkeypatch)
    try:
        result = await asyncio.wait_for(task_app._finish_terminal(
            row.model_copy(), "success" if awaiting_usage else "failure", {}, 200, b"{}", now,
            require_usage=awaiting_usage), 5)
        assert result == ("awaiting_usage" if awaiting_usage else "released")
        assert probe.calls == [("async", [])]
        assert not probe.requested.is_set()
    finally:
        probe.close()
    async with session_maker() as db:
        hold = await db.get(Hold, call_id)
        assert (hold is not None) == awaiting_usage
        assert await ledger.balance_of(db, org_id) == (900 if awaiting_usage else 1_000)


async def test_known_rollback_releases_admission_before_retrying_whole_settlement(money_db, monkeypatch):
    from sqlalchemy.exc import DBAPIError

    org_id = await _fund("retry")
    await _reserve(org_id, "retry")
    original = ledger.settle_in_transaction
    attempts = 0

    class Deadlock(Exception):
        sqlstate = "40P01"

    async def deadlock_after_writes(*args, **kwargs):
        nonlocal attempts
        attempts += 1
        consumed = await original(*args, **kwargs)
        if attempts == 1:
            raise DBAPIError("test deadlock", {}, Deadlock())
        return consumed

    monkeypatch.setattr(ledger, "settle_in_transaction", deadlock_after_writes)
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()
    try:
        result = await call_settle._platform_settle(_call(org_id, "retry"), 200, observed_override=70)
        assert result == (70, 70)
        assert attempts == 2
        assert probe.calls == [("close", [org_id]), ("close", [org_id])]
        assert probe.connections_on_exit == [0, 0]
    finally:
        probe.close()
    async with session_maker() as db:
        assert await ledger.balance_of(db, org_id) == 930
        assert await db.get(Hold, "retry") is None
        entries = (await db.execute(select(LedgerEntry).where(
            LedgerEntry.call_id == "retry", LedgerEntry.kind == "settle"))).scalars().all()
        assert [entry.amount_micro for entry in entries] == [-70]


@pytest.mark.parametrize("kind", ["close", "deferred", "async", "hub"])
async def test_repeated_cancel_joins_session_rollback_before_releasing_admission(money_db, monkeypatch, kind):
    org_id = await _fund("repeated-cancel")
    operation, _, call_id = await _paid_case(kind, org_id)
    ledger_done, closing, allow_close = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_close = AsyncSession.close
    ledger_method = ("settle_to_in_transaction" if kind == "hub" else
                     "close_holds_in_transaction" if kind == "deferred" else "settle_in_transaction")
    original_ledger = getattr(ledger, ledger_method)

    async def before_commit(*args, **kwargs):
        result = await original_ledger(*args, **kwargs)
        ledger_done.set()
        await asyncio.Event().wait()
        return result

    async def delayed_close(db):
        closing.set()
        await allow_close.wait()
        await original_close(db)

    monkeypatch.setattr(ledger, ledger_method, before_commit)
    monkeypatch.setattr(AsyncSession, "close", delayed_close)
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()
    task = asyncio.create_task(operation)
    try:
        await asyncio.wait_for(ledger_done.wait(), 5)
        assert probe.connections
        task.cancel()
        await asyncio.wait_for(closing.wait(), 5)
        task.cancel()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not task.done(), "repeated cancellation must still join session cleanup"
        assert probe.connections and not probe.connections_on_exit
        allow_close.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert not probe.connections
        assert probe.connections_on_exit == [0]
    finally:
        allow_close.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        probe.close()
        monkeypatch.setattr(AsyncSession, "close", original_close)
    async with session_maker() as db:
        # Cancellation happened before commit: all staged writes rolled back together.
        assert await db.get(Hold, call_id) is not None
        assert await ledger.balance_of(db, org_id) == 900
        entries = (await db.execute(select(LedgerEntry).where(
            LedgerEntry.call_id == call_id, LedgerEntry.kind == "settle"))).scalars().all()
        assert entries == []
        await ledger.release(db, call_id, reason="test_cancelled")
        assert await ledger.balance_of(db, org_id) == 1_000


async def test_cancellation_first_arriving_during_session_exit_still_propagates(money_db, monkeypatch):
    org_id = await _fund("cancel-on-exit")
    closing, allow_close = asyncio.Event(), asyncio.Event()
    original_close = AsyncSession.close

    async def delayed_close(db):
        closing.set()
        await allow_close.wait()
        await original_close(db)

    monkeypatch.setattr(AsyncSession, "close", delayed_close)
    probe = AdmissionProbe(monkeypatch)
    probe.allow.set()

    async def work():
        async with money_admission.admit([org_id], operation="close"), money_session(session_maker()) as db:
            await db.get(Org, org_id)

    task = asyncio.create_task(work())
    try:
        await asyncio.wait_for(closing.wait(), 5)
        task.cancel()
        await asyncio.sleep(0)
        assert probe.connections and not probe.connections_on_exit
        allow_close.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 5)
        assert probe.connections_on_exit == [0]
    finally:
        allow_close.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        probe.close()
        monkeypatch.setattr(AsyncSession, "close", original_close)


async def test_session_cleanup_failure_does_not_replace_original_money_error(caplog):
    failure = ValueError("original money failure")

    class BrokenSession:
        async def close(self):
            raise RuntimeError("close failed")

    with pytest.raises(ValueError) as caught:
        async with money_session(BrokenSession()):
            raise failure
    assert caught.value is failure
    assert "money session cleanup failed" in caplog.text
    assert "close failed" in caplog.text
