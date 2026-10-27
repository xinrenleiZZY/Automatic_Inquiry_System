"""阶段一：任务卡片的已联系数必须按 conv_key 去重。"""

import sqlite3

import pytest

from app import config, repo


@pytest.fixture()
def im_db(tmp_path, monkeypatch):
    path = tmp_path / "im.db"
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE campaigns (
            id INTEGER PRIMARY KEY, name TEXT, status TEXT, stage TEXT,
            created_at INTEGER, updated_at INTEGER, note TEXT
        );
        CREATE TABLE image_contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT, epoch INTEGER, rank INTEGER,
            offer_id TEXT, shop_name TEXT, seller_nick TEXT, chat_uid TEXT,
            status TEXT, campaign_id INTEGER, conv_key TEXT, chat_peer TEXT
        );
        CREATE TABLE supplier_quotes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER,
            quote_source TEXT, unit_price_final REAL
        );
        CREATE TABLE offer_prices (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER);

        INSERT INTO campaigns (id, name, status, stage, created_at, updated_at)
        VALUES (7, '定制鼠标垫2', 'running', 'contacted', 1, 1);

        /* 同一个 conv_key 的多张卡片只能算 1 家 */
        INSERT INTO image_contacts
            (epoch, rank, offer_id, shop_name, seller_nick, chat_uid, status,
             campaign_id, conv_key, chat_peer)
        VALUES
            (1, 1, 'o1', '店一', '店一', 'c1', 'opened', 7, 'c1', 'p1'),
            (2, 2, 'o2', '店一', '店一', 'c1', 'opened', 7, 'c1', 'p1'),
            (3, 3, 'o3', '店二', '店二', 'c2', 'opened', 7, 'c2', 'p2');
        """
    )
    conn.commit()
    conn.close()
    monkeypatch.setattr(config, "IM_DB", path)
    return path


def test_campaign_contact_count_prefers_conv_key(im_db):
    rows = repo.list_campaigns(limit=10)
    assert len(rows) == 1
    assert rows[0]["contact_count"] == 2
