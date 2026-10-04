"""验签：原始字节、HMAC-SHA256、时间戳容差。"""

from __future__ import annotations

import base64
import json

import pytest

from monitor_mail.signature import (
    ID_HEADER,
    SIGNATURE_HEADER,
    TIMESTAMP_HEADER,
    SignatureError,
    compute_signature,
    sign_headers,
    verify_signature,
)

SECRET = "unit-test-secret"
BODY = b'{"id":"d1","event":"mail.ready"}'
NOW = 1_790_000_000


def _verify(body=BODY, headers=None, secret=SECRET, now=NOW, tolerance=300):
    headers = headers if headers is not None else sign_headers(body=body, delivery_id="d1", timestamp=NOW, secret=SECRET)
    return verify_signature(body=body, headers=headers, secret=secret, now=now, tolerance_seconds=tolerance)


def test_valid_signature_returns_delivery_id():
    verified = _verify()
    assert verified.delivery_id == "d1"
    assert verified.timestamp == NOW


def test_signature_matches_mail_service_algorithm():
    # 与 remotedesk-resend security/signature.py::digest 相同的构造：base64(hmac(secret, id.ts.body))
    import hashlib
    import hmac

    expected = base64.b64encode(hmac.new(SECRET.encode(), b"d1." + str(NOW).encode() + b"." + BODY,
                                         hashlib.sha256).digest()).decode()
    assert compute_signature(body=BODY, delivery_id="d1", timestamp=NOW, secret=SECRET) == expected


def test_headers_are_case_insensitive():
    headers = {k.lower(): v for k, v in sign_headers(body=BODY, delivery_id="d1", timestamp=NOW, secret=SECRET).items()}
    assert _verify(headers=headers).delivery_id == "d1"


def test_any_v1_candidate_may_match():
    headers = sign_headers(body=BODY, delivery_id="d1", timestamp=NOW, secret=SECRET)
    headers[SIGNATURE_HEADER] = "v1,AAAA " + headers[SIGNATURE_HEADER]
    assert _verify(headers=headers).delivery_id == "d1"


def test_whsec_prefixed_secret_is_base64():
    raw = b"binary-secret"
    secret = "whsec_" + base64.b64encode(raw).decode()
    headers = sign_headers(body=BODY, delivery_id="d1", timestamp=NOW, secret=secret)
    assert verify_signature(body=BODY, headers=headers, secret=secret, now=NOW).delivery_id == "d1"


@pytest.mark.parametrize(
    ("mutate", "reason"),
    [
        (lambda h: h.update({SIGNATURE_HEADER: "v1,bm90LXRoZS1zaWduYXR1cmU="}), "signature_mismatch"),
        (lambda h: h.update({SIGNATURE_HEADER: "v2,abc"}), "signature_mismatch"),
        (lambda h: h.pop(ID_HEADER), "missing_headers"),
        (lambda h: h.update({TIMESTAMP_HEADER: "soon"}), "malformed_timestamp"),
    ],
)
def test_bad_headers_rejected(mutate, reason):
    headers = sign_headers(body=BODY, delivery_id="d1", timestamp=NOW, secret=SECRET)
    mutate(headers)
    with pytest.raises(SignatureError) as exc:
        _verify(headers=headers)
    assert exc.value.reason == reason


def test_wrong_secret_rejected():
    with pytest.raises(SignatureError) as exc:
        _verify(secret="another-secret")
    assert exc.value.reason == "signature_mismatch"


def test_reserialised_body_fails():
    """把 JSON 解析后再序列化（键序、分隔符变化）就对不上——必须用原始字节。"""
    reserialised = json.dumps(json.loads(BODY), indent=1).encode()
    headers = sign_headers(body=BODY, delivery_id="d1", timestamp=NOW, secret=SECRET)
    with pytest.raises(SignatureError):
        _verify(body=reserialised, headers=headers)


@pytest.mark.parametrize("offset", [301, -301])
def test_timestamp_outside_tolerance_rejected(offset):
    with pytest.raises(SignatureError) as exc:
        _verify(now=NOW + offset)
    assert exc.value.reason == "timestamp_out_of_tolerance"


def test_timestamp_at_tolerance_edge_accepted():
    assert _verify(now=NOW + 300).delivery_id == "d1"


def test_unconfigured_secret_rejects_everything():
    with pytest.raises(SignatureError) as exc:
        _verify(secret="")
    assert exc.value.reason == "secret_not_configured"
