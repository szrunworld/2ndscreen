"""简历文档：原件去重与关联方式、品牌化版本、解析结果、人工关联（含邮件 needs_review → processed）、
列表与详情，以及 F2 用的内部事件 ResumeDocumentLinked。"""

from __future__ import annotations

import pytest
from server_testkit import (
    ACCOUNT,
    CONSOLE_TOKEN,
    SERVICE_TOKEN,
    Harness,
    assert_problem,
    assert_shape,
    load_openapi_yaml,
    mail_body,
    put_mail,
    resume_body,
)

from app.resume_documents import DocRow, ResumeDocumentCreate, ResumeDocumentLinked, ResumeDocumentParsed

MAIL_ID = "mail:3f6c2a9e-1b4d-4e8a-9c7f-2d5e8b1a0c44"


def new_case(h: Harness, name: str = "候选人A", job: str = "后端工程师") -> str:
    """经 F2 建立一个招聘流程（new_application），返回 case_id。"""
    row, _ = h.ctx.cases.open_case(ACCOUNT, {"candidate_name": name, "job_title": job, "hints": []}, f"evt_{name}")
    return row.case_id


def stage(h: Harness, case_id: str) -> str:
    return h.ctx.cases.get(case_id).stage


@pytest.fixture
def case(h: Harness) -> str:
    return new_case(h)


@pytest.fixture
def mail(h: Harness) -> str:
    assert put_mail(h, mail_body()).status_code == 201
    return MAIL_ID


def create(h: Harness, body: dict, **kw):
    return h.post("/resume-documents", body, token=kw.pop("token", SERVICE_TOKEN), **kw)


def linked_events(h: Harness) -> list[ResumeDocumentLinked]:
    return [m for m in h.messages if isinstance(m, ResumeDocumentLinked)]


def succeeded_request_resume(h: Harness, case_id: str) -> str:
    """造一条该流程已成功的 request_resume 指令，返回 command_id。"""
    device_id, token = h.ready_device()
    cmd = h.command(action="request_resume")
    cmd["workflow_id"] = case_id
    h.ctx.commands.create_command(cmd)
    claimed = h.claim(device_id, token).json()["commands"]
    assert [c["command_id"] for c in claimed] == [cmd["command_id"]]
    resp = h.report(cmd, token)
    assert resp.status_code == 200, resp.text
    return cmd["command_id"]


# ---------------------------------------------------------------------------
# 原件
# ---------------------------------------------------------------------------


def test_original_none_goes_to_manual_queue_and_dedups(h: Harness, mail: str):
    body = resume_body(mail, candidates=["case_a", "case_b"])
    resp = create(h, body)
    assert resp.status_code == 201, resp.text
    doc = resp.json()
    assert_shape(doc, "ResumeDocument")
    assert doc["link_status"] == "needs_manual" and doc["link_method"] == "none" and doc["case_id"] is None
    assert doc["version"] == 1 and doc["duplicate"] is False and doc["parse_status"] == "pending"
    assert doc["message_id"] == "<x@mail.example>" and doc["mail_message_id"] == mail
    assert h.ctx.resume_documents.store.get(doc["doc_id"]).link["candidate_case_ids"] == ["case_a", "case_b"]
    # 换键重复提交：200 + duplicate=true，同一个 doc_id
    dup = create(h, body)
    assert dup.status_code == 200 and dup.json()["duplicate"] is True and dup.json()["doc_id"] == doc["doc_id"]
    assert len(h.get("/resume-documents").json()["items"]) == 1
    assert linked_events(h) == []  # 未关联不发布


def test_replay_same_key(h: Harness, mail: str):
    body = resume_body(mail)
    first = create(h, body, key="doc-key-000001")
    again = create(h, body, key="doc-key-000001")
    assert first.status_code == again.status_code == 201 and first.json() == again.json()


def test_resume_request_link_publishes_event_and_versions(h: Harness, mail: str, case: str):
    command_id = succeeded_request_resume(h, case)
    body = resume_body(mail, method="resume_request", case_id=case, command_id=command_id)
    doc = create(h, body).json()
    assert doc["link_status"] == "linked" and doc["link_method"] == "resume_request" and doc["case_id"] == case
    events = linked_events(h)
    assert len(events) == 1
    ev = events[0]
    assert (ev.doc_id, ev.case_id, ev.link_method, ev.command_id, ev.version, ev.actor) == (
        doc["doc_id"], case, "resume_request", command_id, 1, None,
    )
    assert ev.mail_message_id == mail and ev.record == doc
    # 同一流程第二份原件：版本 2，不覆盖
    second = create(h, resume_body(mail, sha="c" * 64, method="reliable_id", case_id=case)).json()
    assert second["version"] == 2 and second["doc_id"] != doc["doc_id"]
    assert [d["version"] for d in h.get("/resume-documents", params={"case_id": case}).json()["items"]] == [2, 1]
    # 重复提交不再发布
    create(h, body)
    assert len(linked_events(h)) == 2


@pytest.mark.parametrize(
    ("link", "path", "code"),
    [
        ({"method": "name_match", "case_id": None}, "link.case_id", "required"),
        ({"method": "none", "case_id": "case_x"}, "link.case_id", "not_allowed"),
        ({"method": "resume_request", "case_id": "case_x"}, "link.command_id", "required"),
        ({"method": "resume_request", "case_id": "case_x", "command_id": "00000000-0000-4000-8000-0000000000ff"}, "link.command_id", "link_command_invalid"),
        ({"method": "reliable_id", "case_id": "case_x", "command_id": "00000000-0000-4000-8000-0000000000ff"}, "link.command_id", "not_allowed"),
    ],
)
def test_link_decision_rules(h: Harness, mail: str, link: dict, path: str, code: str):
    body = resume_body(mail)
    body["link"] = link
    err = assert_problem(create(h, body), 422, "validation_failed")
    assert (path, code) in [(e["path"], e["code"]) for e in err["errors"]]


def test_resume_request_must_match_case_and_succeed(h: Harness, mail: str, case: str):
    command_id = succeeded_request_resume(h, case)
    body = resume_body(mail, method="resume_request", case_id=new_case(h, "候选人B"), command_id=command_id)
    err = assert_problem(create(h, body), 422)
    assert err["errors"][0]["code"] == "link_command_invalid"
    pending = h.create(action="send_greeting")["command"]["command_id"]  # 不是 request_resume
    body = resume_body(mail, method="resume_request", case_id=case, command_id=pending)
    assert assert_problem(create(h, body), 422)["errors"][0]["code"] == "link_command_invalid"


def test_unknown_case_rejected(h: Harness, mail: str, case: str):
    h.ctx.resume_documents.case_exists = lambda case_id: case_id == case
    err = assert_problem(create(h, resume_body(mail, method="name_match", case_id="case_x")), 422)
    assert err["errors"][0]["code"] == "unknown_case"
    assert create(h, resume_body(mail, method="name_match", case_id=case)).status_code == 201


def test_original_errors(h: Harness, mail: str):
    assert_problem(create(h, resume_body("mail:11111111-2222-4333-8444-555555555555")), 404)
    for missing in ("mail", "link", "mail_message_id"):
        body = resume_body(mail)
        del body[missing]
        err = assert_problem(create(h, body), 422)
        assert missing in [e["path"] for e in err["errors"]]
    assert_problem(create(h, resume_body(mail, derived_from="doc_x")), 422)
    bad_sha = resume_body(mail)
    bad_sha["attachment"]["sha256"] = "XYZ"
    assert_problem(create(h, bad_sha), 422)
    bad_time = resume_body(mail)
    bad_time["mail"]["received_at"] = "2026-10-04T10:02:00"
    assert_problem(create(h, bad_time), 422)
    assert_problem(create(h, resume_body(mail), token=CONSOLE_TOKEN), 401)
    assert_problem(create(h, resume_body(mail), key=None), 422)


def test_parse_result_with_create(h: Harness, mail: str):
    body = resume_body(mail, parse={"parse_status": "suspected_scanned", "text_storage_uri": None, "page_count": 2, "error": None})
    doc = create(h, body).json()
    assert doc["parse_status"] == "suspected_scanned"
    assert [m.parse_status for m in h.messages if isinstance(m, ResumeDocumentParsed)] == ["suspected_scanned"]


# ---------------------------------------------------------------------------
# 品牌化版本
# ---------------------------------------------------------------------------


def branded_body(derived_from: str, sha: str = "d" * 64, **extra) -> dict:
    body = {
        "variant": "branded",
        "derived_from": derived_from,
        "attachment": {
            "filename": "resume-branded.pdf",
            "sha256": sha,
            "size_bytes": 2048,
            "content_type": "application/pdf",
            "storage_uri": "file:///tmp/branded.pdf",
        },
    }
    body.update(extra)
    return body


def test_branded_inherits_original(h: Harness, mail: str, case: str):
    original = create(h, resume_body(mail, method="reliable_id", case_id=case)).json()
    resp = create(h, branded_body(original["doc_id"]))
    assert resp.status_code == 201, resp.text
    branded = resp.json()
    assert_shape(branded, "ResumeDocument")
    assert branded["variant"] == "branded" and branded["derived_from"] == original["doc_id"]
    assert (branded["case_id"], branded["mail_message_id"], branded["version"], branded["link_status"]) == (
        case, mail, 1, "linked",
    )
    dup = create(h, branded_body(original["doc_id"]))
    assert dup.status_code == 200 and dup.json()["duplicate"] is True
    # 原件始终保留
    assert h.get(f"/resume-documents/{original['doc_id']}").json()["variant"] == "original"
    assert len(linked_events(h)) == 1  # 品牌化版本不再发布关联事件
    assert [d["doc_id"] for d in h.get("/resume-documents", params={"variant": "branded"}).json()["items"]] == [branded["doc_id"]]


def test_branded_errors(h: Harness, mail: str):
    original = create(h, resume_body(mail)).json()
    assert_problem(create(h, branded_body("doc_missing")), 404)
    branded = create(h, branded_body(original["doc_id"])).json()
    err = assert_problem(create(h, branded_body(branded["doc_id"], sha="e" * 64)), 422)
    assert err["errors"][0]["code"] == "not_original"
    assert_problem(create(h, branded_body(original["doc_id"], link={"method": "none", "case_id": None})), 422)
    assert_problem(create(h, branded_body(original["doc_id"], mail=resume_body(mail)["mail"])), 422)
    assert_problem(create(h, branded_body(original["doc_id"], mail=None)), 422)  # mail 不能出现，null 也不行
    wrong_mail = branded_body(original["doc_id"], mail_message_id="mail:11111111-2222-4333-8444-555555555555")
    assert assert_problem(create(h, wrong_mail), 422)["errors"][0]["code"] == "mismatch"
    no_parent = branded_body(original["doc_id"])
    del no_parent["derived_from"]
    assert_problem(create(h, no_parent), 422)


# ---------------------------------------------------------------------------
# 解析结果
# ---------------------------------------------------------------------------


def test_parse_result(h: Harness, mail: str):
    doc = create(h, resume_body(mail)).json()
    body = {"parse_status": "parsed", "text_storage_uri": "file:///tmp/t.txt", "page_count": 2, "error": None}
    resp = h.post(f"/resume-documents/{doc['doc_id']}/parse-result", body, token=SERVICE_TOKEN)
    assert resp.status_code == 200, resp.text
    assert_shape(resp.json(), "ResumeDocument")
    assert resp.json()["parse_status"] == "parsed"
    assert h.ctx.resume_documents.store.get(doc["doc_id"]).parse == body
    assert [m.parse_status for m in h.messages if isinstance(m, ResumeDocumentParsed)] == ["parsed"]


def test_parse_result_errors(h: Harness, mail: str):
    doc = create(h, resume_body(mail)).json()
    path = f"/resume-documents/{doc['doc_id']}/parse-result"
    assert_problem(h.post("/resume-documents/doc_missing/parse-result", {"parse_status": "parsed"}, token=SERVICE_TOKEN), 404)
    assert_problem(h.post(path, {"parse_status": "done"}, token=SERVICE_TOKEN), 422)
    assert_problem(h.post(path, {"parse_status": "parsed", "page_count": -1}, token=SERVICE_TOKEN), 422)
    assert_problem(h.post(path, {"parse_status": "parsed", "x": 1}, token=SERVICE_TOKEN), 422)
    assert_problem(h.post(path, {"parse_status": "parsed"}, token=CONSOLE_TOKEN), 401)


# ---------------------------------------------------------------------------
# 人工关联
# ---------------------------------------------------------------------------


def link(h: Harness, doc_id: str, case_id: str, note: str = "核对过姓名与岗位", **kw):
    return h.post(f"/resume-documents/{doc_id}:link", {"case_id": case_id, "note": note}, **kw)


def test_manual_link_records_actor_and_advances_mail(h: Harness, mail: str, case: str):
    put_mail(h, mail_body("mail_message_needs_review"))
    doc = create(h, resume_body(mail)).json()
    branded = create(h, branded_body(doc["doc_id"])).json()
    resp = link(h, doc["doc_id"], case)
    assert resp.status_code == 200, resp.text
    action = resp.json()
    assert_shape(action, "ManualAction")
    assert (action["type"], action["actor"], action["note"]) == ("link_resume", "alice", "核对过姓名与岗位")
    assert action["target"] == {"kind": "resume_document", "id": doc["doc_id"]}
    current = h.get(f"/resume-documents/{doc['doc_id']}").json()
    assert (current["link_status"], current["link_method"], current["case_id"], current["version"]) == (
        "linked", "manual", case, 1,
    )
    # 原始的关联判定保留，不被覆盖
    assert h.ctx.resume_documents.store.get(doc["doc_id"]).link["method"] == "none"
    # 品牌化版本随原件关联
    assert h.get(f"/resume-documents/{branded['doc_id']}").json()["case_id"] == case
    ev = linked_events(h)[-1]
    assert (ev.doc_id, ev.case_id, ev.link_method, ev.actor) == (doc["doc_id"], case, "manual", "alice")
    # 来源邮件 needs_review → processed
    assert h.ctx.mail.store.get_message(mail)["status"] == "processed"
    assert h.store.list_manual_actions("resume_document", doc["doc_id"])[0].actor == "alice"


def test_manual_link_keeps_mail_in_review_until_all_linked(h: Harness, mail: str, case: str):
    put_mail(h, mail_body("mail_message_needs_review"))
    first = create(h, resume_body(mail)).json()
    create(h, resume_body(mail, sha="c" * 64))
    link(h, first["doc_id"], case)
    assert h.ctx.mail.store.get_message(mail)["status"] == "needs_review"


def test_manual_link_conflicts(h: Harness, mail: str, case: str):
    doc = create(h, resume_body(mail)).json()
    assert link(h, doc["doc_id"], case).status_code == 200
    published = len(linked_events(h))
    # 同一流程再次关联：只补记人工处理
    again = link(h, doc["doc_id"], case, note="复核")
    assert again.status_code == 200 and len(linked_events(h)) == published
    assert len(h.store.list_manual_actions("resume_document", doc["doc_id"])) == 2
    err = assert_problem(link(h, doc["doc_id"], new_case(h, "候选人B")), 409, "already_linked")
    assert err["existing"]["case_id"] == case
    branded = create(h, branded_body(doc["doc_id"])).json()
    assert_problem(link(h, branded["doc_id"], case), 409, "not_original")


def test_manual_link_errors(h: Harness, mail: str, case: str):
    doc = create(h, resume_body(mail)).json()
    assert_problem(link(h, "doc_missing", case), 404)
    h.ctx.resume_documents.case_exists = lambda case_id: False
    assert_problem(link(h, doc["doc_id"], case), 404)
    h.ctx.resume_documents.case_exists = lambda case_id: True
    assert_problem(link(h, doc["doc_id"], case, note=""), 422)
    assert_problem(h.post(f"/resume-documents/{doc['doc_id']}:link", {"case_id": case}), 422)
    assert_problem(link(h, doc["doc_id"], case, token=SERVICE_TOKEN), 401)
    assert_problem(link(h, doc["doc_id"], case, key=None), 422)


# ---------------------------------------------------------------------------
# 列表与详情
# ---------------------------------------------------------------------------


def test_list_and_get(h: Harness, mail: str, case: str):
    a = create(h, resume_body(mail)).json()
    b = create(h, resume_body(mail, sha="c" * 64, method="name_match", case_id=case)).json()
    resp = h.get("/resume-documents", params={"link_status": "needs_manual"})
    assert [d["doc_id"] for d in resp.json()["items"]] == [a["doc_id"]]
    for d in h.get("/resume-documents").json()["items"]:
        assert_shape(d, "ResumeDocument")
    by_service = h.get("/resume-documents", params={"case_id": case}, token=SERVICE_TOKEN).json()
    assert [d["doc_id"] for d in by_service["items"]] == [b["doc_id"]]
    assert len(h.get("/resume-documents", params={"mail_message_id": mail}).json()["items"]) == 2
    page = h.get("/resume-documents", params={"limit": 1}).json()
    assert page["items"][0]["doc_id"] == b["doc_id"] and page["next_cursor"] is not None
    assert h.get(f"/resume-documents/{a['doc_id']}", token=SERVICE_TOKEN).json()["doc_id"] == a["doc_id"]
    assert_problem(h.get("/resume-documents/doc_missing"), 404)
    assert_problem(h.get("/resume-documents", params={"variant": "x"}), 422)
    assert_problem(h.get("/resume-documents", params={"mail_message_id": "bogus"}), 422)
    assert_problem(h.get("/resume-documents", token=None), 401)
    assert_problem(h.get(f"/resume-documents/{a['doc_id']}", token=None), 401)


def test_store_insert_race_returns_false(h: Harness, mail: str):
    doc = create(h, resume_body(mail)).json()
    row = h.ctx.resume_documents.store.get(doc["doc_id"])
    clone = DocRow(**{**row.__dict__, "doc_id": "doc_clone"})
    assert h.ctx.resume_documents.store.insert(clone) is False  # (mail_message_id, sha256) 唯一


def test_create_schema_properties_match_yaml():
    """一致性测试把 ResumeDocumentCreate 的 allOf 条件规则当成整体比较（会掩盖属性差异），这里单独核对属性。"""
    from app.main import create_app, export_openapi
    from test_openapi_consistency import norm

    code = export_openapi(create_app())
    yaml_spec = load_openapi_yaml()
    c = {k: v for k, v in code["components"]["schemas"]["ResumeDocumentCreate"].items() if k != "allOf"}
    y = {k: v for k, v in yaml_spec["components"]["schemas"]["ResumeDocumentCreate"].items() if k != "allOf"}
    assert norm(c, code) == norm(y, yaml_spec)
    assert ResumeDocumentCreate.model_json_schema()["allOf"] == y_rule(yaml_spec)


def y_rule(yaml_spec: dict) -> list:
    return yaml_spec["components"]["schemas"]["ResumeDocumentCreate"]["allOf"]


# ---------------------------------------------------------------------------
# 与 F2 的衔接：link_resume / mark_resume_parsed / to_needs_human / resume_documents_provider
# ---------------------------------------------------------------------------


def test_auto_link_advances_case_to_resume_linked(h: Harness, mail: str, case: str):
    assert stage(h, case) == "new_application"
    doc = create(h, resume_body(mail, method="name_match", case_id=case)).json()
    assert stage(h, case) == "resume_linked"
    assert h.ctx.cases.repo.resume_link(doc["doc_id"])["case_id"] == case
    # 流程详情里的简历文件来自本模块
    detail = h.get(f"/cases/{case}").json()
    assert [d["doc_id"] for d in detail["resume_documents"]] == [doc["doc_id"]]
    assert "resume_linked" in [t["type"] for t in detail["timeline"]]


def test_parsed_marks_case_link(h: Harness, mail: str, case: str):
    doc = create(h, resume_body(mail, method="name_match", case_id=case)).json()
    assert h.ctx.cases.repo.resume_link(doc["doc_id"])["parsed_at"] is None
    h.post(f"/resume-documents/{doc['doc_id']}/parse-result", {"parse_status": "parsed"}, token=SERVICE_TOKEN)
    assert h.ctx.cases.repo.resume_link(doc["doc_id"])["parsed_at"] is not None


def test_parsed_before_manual_link_is_counted_on_link(h: Harness, mail: str, case: str):
    doc = create(h, resume_body(mail)).json()
    h.post(f"/resume-documents/{doc['doc_id']}/parse-result", {"parse_status": "parsed"}, token=SERVICE_TOKEN)
    assert h.ctx.cases.repo.resume_link(doc["doc_id"]) is None  # 未关联时 F2 不记
    assert link(h, doc["doc_id"], case).status_code == 200
    assert stage(h, case) == "resume_linked"
    assert h.ctx.cases.repo.resume_link(doc["doc_id"])["parsed_at"] is not None


def test_ambiguous_candidates_go_to_needs_human(h: Harness, mail: str, case: str):
    other = new_case(h, "候选人A", "前端工程师")
    create(h, resume_body(mail, candidates=[case, other, "case_missing"]))
    assert stage(h, case) == stage(h, other) == "needs_human"
    assert h.ctx.cases.get(case).needs_human_reason == "resume_link_ambiguous"


def test_case_failure_rolls_back_document(h: Harness, mail: str, case: str):
    def boom(case_id: str, doc_id: str) -> bool:
        raise RuntimeError("F2 失败")

    h.ctx.cases.link_resume = boom  # type: ignore[method-assign]
    with pytest.raises(RuntimeError):
        create(h, resume_body(mail, method="name_match", case_id=case))
    assert h.ctx.resume_documents.store.find_original(mail, "b" * 64) is None  # 文档与流程一起回滚


def test_default_case_exists_uses_f2(h: Harness, mail: str):
    err = assert_problem(create(h, resume_body(mail, method="name_match", case_id="case_missing")), 422)
    assert err["errors"][0]["code"] == "unknown_case"


def test_service_token_reads_policy_but_cannot_write(h: Harness, case: str):
    resp = h.get(f"/accounts/{ACCOUNT}/policy", token=SERVICE_TOKEN)
    assert resp.status_code == 200, resp.text
    assert resp.json()["mail_retention_days"] == 30 and resp.json()["resume_mail_timeout_days"] == 3
    put = h.post(f"/accounts/{ACCOUNT}/policy", resp.json(), token=SERVICE_TOKEN, method="PUT")
    assert_problem(put, 401)
    assert_problem(h.get(f"/accounts/{ACCOUNT}/policy", token="bogus"), 401)
