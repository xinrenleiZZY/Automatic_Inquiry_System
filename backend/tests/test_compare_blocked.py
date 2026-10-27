"""比价表不能把名单占位行当成真实商家。"""

import sqlite3

import pytest

from app import config, repo


@pytest.fixture()
def im_db(tmp_path, monkeypatch):
    path = tmp_path / "im.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE campaigns (id INTEGER PRIMARY KEY, name TEXT, image_file TEXT);
        CREATE TABLE offer_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            offer_id TEXT, page_price_num REAL, shop_name TEXT
        );
        CREATE TABLE supplier_quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campaign_id INTEGER, conv_key TEXT, supplier_wangwang TEXT,
            status TEXT, quote_source TEXT, offer_id TEXT,
            page_price TEXT, unit_price TEXT, unit_price_final REAL,
            raw_text TEXT, remark TEXT, updated_at INTEGER,
            not_doing_reason TEXT, handoff_contact TEXT
        );
        INSERT INTO campaigns (id, name) VALUES (7, '定制鼠标垫2');
        INSERT INTO supplier_quotes
            (campaign_id, conv_key, supplier_wangwang, status, quote_source,
             raw_text, updated_at)
        VALUES
            (7, 'conv-real', '真实商家', 'asking', 'none', '单价 1.20 元', 1),
            (7, 'conv-dropped', '真实不做商家', 'dropped', 'none',
             '这款做不了', 2),
            (7, 'conv-audit', '补分析商家', 'dropped', 'audit',
             '', 3),
            (7, 'conv-blocked', '黑名单占位', 'dropped', 'blocked',
             '', 4);
        """
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(config, "IM_DB", path)
    return path


def test_compare_always_excludes_blocked_placeholders(im_db):
    rows = repo.compare(campaign_id=7, include_dropped=True)
    assert {r["conv_key"] for r in rows} == {
        "conv-real", "conv-dropped", "conv-audit",
    }
    assert all(r["quote_source"] != "blocked" for r in rows)


def test_compare_still_can_hide_real_dropped_rows(im_db):
    rows = repo.compare(campaign_id=7, include_dropped=False)
    assert [r["conv_key"] for r in rows] == ["conv-real"]
