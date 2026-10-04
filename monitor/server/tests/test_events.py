"""事件接收：批量按 event_id 去重、逐条校验、进程内订阅、列表查询。"""

from __future__ import annotations

from conftest import ACCOUNT, Harness, assert_problem, assert_shape, vector

from app.events import EventReceived, InProcessEventBus
from monitor_contracts import compute_event_id


def make_event(
    device_id: str, name: str = "event_application_observed", bucket: str | None = None, account_id: str = ACCOUNT
) -> dict:
    """取 A 的合法事件向量，换成本设备；换 bucket 时重新计算 event_id。"""
    event = vector(name)
    event["device_id"] = device_id
    if bucket is not None or account_id != event.get("account_id"):
        event["bucket"] = bucket or event["bucket"]
        event["account_id"] = account_id
        event["event_id"] = compute_event_id(account_id, event["kind"], event["conversation"], event["bucket"])
    return event


def post(h: Harness, device_id: str, token: str, events: list, **kw):
    return h.post("/events", {"device_id": device_id, "events": events}, token=token, **kw)


def received(h: Harness) -> list[EventReceived]:
    return [m for m in h.messages if isinstance(m, EventReceived)]


def test_events_accepted_stored_and_published(h: Harness):
    device_id, token = h.register()
    e1 = make_event(device_id)
    e2 = make_event(device_id, "event_attachment_available")
    resp = post(h, device_id, token, [e1, e2])
    assert resp.status_code == 200
    assert_shape(resp.json(), "EventBatchResult")
    assert [(r["index"], r["event_id"], r["status"]) for r in resp.json()["results"]] == [
        (0, e1["event_id"], "accepted"),
        (1, e2["event_id"], "accepted"),
    ]
    stored = h.store.get_event(e1["event_id"])
    assert stored is not None and stored.event == e1 and stored.case_id is None
    msgs = received(h)
    assert [m.event_id for m in msgs] == [e1["event_id"], e2["event_id"]]
    assert msgs[0].kind == "application_observed" and msgs[0].account_id == ACCOUNT
    assert_shape(msgs[0].record, "EventRecord")


def test_duplicate_events_by_event_id(h: Harness):
    device_id, token = h.register()
    e1 = make_event(device_id)
    post(h, device_id, token, [e1])
    # 新批次（不同幂等键）里再次出现、以及同一批次里重复两次
    e2 = make_event(device_id, bucket="2026-10-04T02:00:00Z/3600")
    resp = post(h, device_id, token, [e1, e2, e2])
    assert [r["status"] for r in resp.json()["results"]] == ["duplicate", "accepted", "duplicate"]
    assert [m.event_id for m in received(h)] == [e1["event_id"], e2["event_id"]]  # 每个事件只发布一次


def test_invalid_event_rejected_without_failing_batch(h: Harness):
    device_id, token = h.register()
    good = make_event(device_id)
    bad_id = dict(make_event(device_id, "event_attachment_available"), event_id="0" * 64)
    bad_shape = {"kind": "application_observed"}
    other_device = make_event("dev_someone_else", "event_login_required")
    resp = post(h, device_id, token, [bad_id, good, bad_shape, other_device])
    assert resp.status_code == 200
    assert_shape(resp.json(), "EventBatchResult")
    results = resp.json()["results"]
    assert [r["status"] for r in results] == ["rejected", "accepted", "rejected", "rejected"]
    assert "event_id" in [e["path"] for e in results[0]["errors"]]
    assert results[0]["event_id"] == "0" * 64
    assert results[2]["event_id"] is None and results[2]["errors"]
    assert results[3]["errors"][0]["path"] == "device_id"
    assert h.store.get_event(bad_id["event_id"]) is None


def test_event_batch_errors(h: Harness):
    a_id, a_token = h.register()
    b_id, _ = h.register()
    event = make_event(a_id)
    assert_problem(post(h, a_id, None, [event]), 401)
    problem = assert_problem(post(h, b_id, a_token, [make_event(b_id)]), 422)
    assert problem["errors"][0]["path"] == "device_id"
    assert_problem(post(h, a_id, a_token, []), 422)
    assert_problem(post(h, a_id, a_token, [event] * 101), 422)
    assert_problem(post(h, a_id, a_token, [event], key=None), 422)
    assert_problem(post(h, a_id, a_token, ["not an object"]), 422)  # 条目必须是对象（EventBatch 结构）


def test_event_batch_replay_with_same_key(h: Harness):
    device_id, token = h.register()
    event = make_event(device_id)
    first = post(h, device_id, token, [event], key="events:batch-1")
    again = post(h, device_id, token, [event], key="events:batch-1")
    assert first.json() == again.json()
    assert [r["status"] for r in again.json()["results"]] == ["accepted"]  # 原样返回首次响应
    assert len(received(h)) == 1


def test_events_from_revoked_device_rejected(h: Harness):
    device_id, token = h.register()
    h.post(f"/devices/{device_id}:revoke")
    assert_problem(post(h, device_id, token, [make_event(device_id)]), 401)


# ---------------------------------------------------------------------------
# 订阅接口
# ---------------------------------------------------------------------------


def test_subscriber_failure_does_not_break_ingest(h: Harness):
    device_id, token = h.register()

    def broken(_message):
        raise RuntimeError("F2 订阅者故障")

    h.bus.subscribe(broken)
    resp = post(h, device_id, token, [make_event(device_id)])
    assert resp.status_code == 200 and resp.json()["results"][0]["status"] == "accepted"
    assert h.bus.failures == 1
    assert len(received(h)) == 1  # 其他订阅者照常收到


def test_unsubscribe_stops_delivery():
    bus = InProcessEventBus()
    got: list = []
    unsubscribe = bus.subscribe(got.append)
    bus.publish("first")  # type: ignore[arg-type]
    unsubscribe()
    unsubscribe()  # 重复取消无害
    bus.publish("second")  # type: ignore[arg-type]
    assert got == ["first"]


def test_link_case_and_get(h: Harness):
    device_id, token = h.register()
    event = make_event(device_id)
    post(h, device_id, token, [event])
    assert h.ctx.events.link_case(event["event_id"], "case_001") is True
    assert h.ctx.events.get(event["event_id"])["case_id"] == "case_001"
    assert h.ctx.events.link_case("f" * 64, "case_001") is False
    assert h.ctx.events.get("f" * 64) is None


# ---------------------------------------------------------------------------
# 列表
# ---------------------------------------------------------------------------


def test_list_events_filters_and_pagination(h: Harness):
    device_id, token = h.register()
    a = make_event(device_id)
    b = make_event(device_id, "event_attachment_available")
    c = make_event(device_id, "event_login_required", account_id=None)  # 登录类事件可不带账户
    post(h, device_id, token, [a, b, c])
    h.ctx.events.link_case(a["event_id"], "case_001")

    resp = h.get("/events", params={"limit": 2})
    assert resp.status_code == 200
    page1 = resp.json()
    for item in page1["items"]:
        assert_shape(item, "EventRecord")
    assert [i["event"]["event_id"] for i in page1["items"]] == [c["event_id"], b["event_id"]]  # 新的在前
    page2 = h.get("/events", params={"limit": 2, "cursor": page1["next_cursor"]}).json()
    assert [i["event"]["event_id"] for i in page2["items"]] == [a["event_id"]] and page2["next_cursor"] is None

    ids = lambda params: [i["event"]["event_id"] for i in h.get("/events", params=params).json()["items"]]  # noqa: E731
    assert ids({"kind": "attachment_available"}) == [b["event_id"]]
    assert ids({"case_id": "case_001"}) == [a["event_id"]]
    assert ids({"account_id": ACCOUNT}) == [b["event_id"], a["event_id"]]


def test_list_events_errors(h: Harness):
    assert_problem(h.get("/events", token=None), 401)
    assert_problem(h.get("/events", params={"limit": 201}), 422)
    assert_problem(h.get("/events", params={"cursor": "x"}), 422)
