import json
import sys
from pathlib import Path

import pytest

GENVM_VERSION = "v0.2.16"  # matches the contract header
CONTRACT = str(Path(__file__).resolve().parents[2] / "contracts" / "delivery_escrow.py")
GEN = 10**18

HOST = "trackings.post.japanpost.jp"
NUMBER = "4370-9143-5196"
URL = f"https://{HOST}/services/srv/search/direct?reqCodeNo1=437091435196&locale=en"
CREATED = "2026-11-10T00:00:00Z"

ORDER_ARGS = dict(
    item="Vintage film camera",
    carrier="Japan Post",
    tracking_host=HOST,
    dest_postal="108",
    dest_city="Tokyo",
    ship_by="2026-11-12T00:00:00Z",
    delivery_deadline="2026-11-20T23:59:59+09:00",  # page times are read in +09:00
    grace_hours=24,
    dispute_hours=0,
    not_before="",
)
CUTOFF = "2026-11-21T14:59:59Z"

POSTED = ("11/11/2026 14:51", "Posting/Collection", "DOUOUSAPPORO", "HOKKAIDO", "009-8799")
DELIVERED_EV = ("11/13/2026 17:27", "Final delivery", "TAKANAWA", "TOKYO", "108-8799")
TRANSIT_EV = ("11/12/2026 06:10", "En route", "TOKYO INT", "TOKYO", "138-8799")
RETURN_EV = ("11/14/2026 09:00", "Returned to sender", "DOUOUSAPPORO", "HOKKAIDO", "009-8799")


def hexaddr(a):
    return a.as_hex if hasattr(a, "as_hex") else str(a)


def page(*events, number=NUMBER, extra=""):
    """Japan-Post-shaped tracking page (plain HTML table)."""
    rows = "".join(
        f"<tr><td>{d}</td><td>{s}</td><td></td><td>{o}</td><td>{p}</td></tr><tr><td>{z}</td></tr>"
        for d, s, o, p, z in events
    )
    return (f"<html><head><title>Detailed Search Results - Japan Post</title>"
            f"<script>var x = '<td>Final delivery</td>';</script><style>td{{}}</style></head><body>"
            f"<h1>Details of search result</h1><table><tr><td>Item number</td><td>Class of goods</td></tr>"
            f"<tr><td>{number}</td><td>LETTERPACK Lite</td></tr></table>"
            f"<table><tr><th>Date</th><th>Shipping track record</th><th>Details</th><th>Office</th>"
            f"<th>Prefecture</th></tr>{rows}</table>{extra}</body></html>")


def answer(status="DELIVERED", date="2026-11-13", time="17:27", postal="108-8799", city="TAKANAWA",
           region="TOKYO", evidence="11/13/2026 17:27 Final delivery TAKANAWA TOKYO 108-8799"):
    return json.dumps({"status": status, "delivered_date": date, "delivered_time": time,
                       "destination_postal": postal, "destination_city": city, "destination_region": region,
                       "evidence": evidence})


DELIVERED_ANSWER = answer()
TRANSIT_ANSWER = answer("IN_TRANSIT", "", "", "138-8799", "TOKYO INT", "TOKYO",
                        "11/12/2026 06:10 En route TOKYO INT TOKYO 138-8799")
RETURN_ANSWER = answer("RETURNED", "", "", "009-8799", "DOUOUSAPPORO", "HOKKAIDO",
                       "11/14/2026 09:00 Returned to sender DOUOUSAPPORO HOKKAIDO 009-8799")


def mock_tracking(vm, html=None, llm=None, status=200, url_pattern=r"trackings\.post\.japanpost\.jp/"):
    if html is None:
        html = page(POSTED, DELIVERED_EV)
    vm.mock_web(url_pattern, {"status": status, "body": html})
    if llm is not None:
        vm.mock_llm(r"TRACKING NUMBER", llm)


@pytest.fixture
def de(direct_vm, direct_deploy):
    direct_vm.check_pickling = True
    direct_vm.warp(CREATED)
    return direct_deploy(CONTRACT, sdk_version=GENVM_VERSION)


@pytest.fixture
def module(de):
    return sys.modules[type(de).__module__]


def make_order(vm, de, buyer, seller, amount=100 * GEN, **over):
    args = dict(ORDER_ARGS)
    args.update(over)
    with vm.prank(buyer):
        vm.value = amount
        try:
            return de.create_order(seller=hexaddr(seller), **args)
        finally:
            vm.value = 0


@pytest.fixture
def order(direct_vm, de, direct_alice, direct_bob):
    """Alice (buyer) escrows 100 GEN for Bob (seller)."""
    return make_order(direct_vm, de, direct_alice, direct_bob)


def ship(vm, de, oid, seller, number=NUMBER, url=URL):
    with vm.prank(seller):
        return de.set_tracking(oid, number, url)


@pytest.fixture
def shipped(direct_vm, de, order, direct_bob):
    direct_vm.warp("2026-11-11T06:00:00Z")
    ship(direct_vm, de, order, direct_bob)
    return order


def after_delivery(vm):
    vm.warp("2026-11-14T00:00:00Z")
