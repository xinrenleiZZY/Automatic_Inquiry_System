#!/usr/bin/env python3
"""Merge two Automatic Inquiry api.db files without discarding either side.

The Windows-native service and the Docker container previously used different
api.db locations. This script treats the first argument as the target and the
second as an additional source, then merges records by their natural keys.

Usage:
    python deploy/merge-api-db.py data/api.db container-api.db
"""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path


TABLES = (
    "settings",
    "customer_flags",
    "jobs",
    "flow_runs",
    "flow_steps",
    "audit",
    "logs",
    "campaign_params",
)


def require_db(path: Path) -> None:
    if not path.is_file():
        raise SystemExit(f"database not found: {path}")
    conn = sqlite3.connect(str(path), timeout=15)
    try:
        check = conn.execute("PRAGMA quick_check").fetchone()
    finally:
        conn.close()
    if not check or str(check[0]).lower() != "ok":
        raise SystemExit(f"database integrity check failed: {path}: {check}")


def counts(conn: sqlite3.Connection) -> dict[str, int]:
    result = {}
    for table in TABLES:
        result[table] = int(conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
    return result


def merge_settings(target: sqlite3.Connection, source: sqlite3.Connection) -> None:
    for key, value, updated_at in source.execute("SELECT key, value, updated_at FROM settings"):
        target.execute(
            """
            INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            WHERE COALESCE(excluded.updated_at, 0) > COALESCE(settings.updated_at, 0)
            """,
            (key, value, updated_at),
        )


def merge_flags(target: sqlite3.Connection, source: sqlite3.Connection) -> None:
    for row in source.execute(
        "SELECT conv_key, campaign_id, conv_name, list_type, note, updated_at "
        "FROM customer_flags"
    ):
        target.execute(
            """
            INSERT INTO customer_flags(
                conv_key, campaign_id, conv_name, list_type, note, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(conv_key, campaign_id) DO UPDATE SET
                conv_name = excluded.conv_name,
                list_type = excluded.list_type,
                note = excluded.note,
                updated_at = excluded.updated_at
            WHERE COALESCE(excluded.updated_at, 0) > COALESCE(customer_flags.updated_at, 0)
            """,
            row,
        )


def merge_jobs(target: sqlite3.Connection, source: sqlite3.Connection) -> None:
    columns = (
        "id", "type", "payload", "status", "progress", "result", "error",
        "created_by", "priority", "created_at", "started_at", "finished_at",
    )
    for row in source.execute(f"SELECT {', '.join(columns)} FROM jobs"):
        target.execute(
            f"""
            INSERT INTO jobs({', '.join(columns)})
            VALUES ({', '.join('?' for _ in columns)})
            ON CONFLICT(id) DO UPDATE SET
                type = excluded.type,
                payload = excluded.payload,
                status = excluded.status,
                progress = excluded.progress,
                result = excluded.result,
                error = excluded.error,
                created_by = excluded.created_by,
                priority = excluded.priority,
                created_at = excluded.created_at,
                started_at = excluded.started_at,
                finished_at = excluded.finished_at
            WHERE COALESCE(excluded.finished_at, excluded.started_at, excluded.created_at, 0)
                >= COALESCE(jobs.finished_at, jobs.started_at, jobs.created_at, 0)
            """,
            row,
        )


def merge_flow_runs(target: sqlite3.Connection, source: sqlite3.Connection) -> None:
    columns = ("id", "campaign_id", "status", "payload", "created_at", "updated_at")
    for row in source.execute(f"SELECT {', '.join(columns)} FROM flow_runs"):
        target.execute(
            f"""
            INSERT INTO flow_runs({', '.join(columns)})
            VALUES ({', '.join('?' for _ in columns)})
            ON CONFLICT(id) DO UPDATE SET
                campaign_id = excluded.campaign_id,
                status = excluded.status,
                payload = excluded.payload,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            WHERE COALESCE(excluded.updated_at, 0) > COALESCE(flow_runs.updated_at, 0)
            """,
            row,
        )


def merge_flow_steps(target: sqlite3.Connection, source: sqlite3.Connection) -> None:
    columns = (
        "id", "flow_id", "campaign_id", "step_no", "kind", "payload", "status",
        "run_after", "attempts", "error", "created_at", "updated_at",
    )
    for row in source.execute(f"SELECT {', '.join(columns)} FROM flow_steps"):
        target.execute(
            f"""
            INSERT INTO flow_steps({', '.join(columns)})
            VALUES ({', '.join('?' for _ in columns)})
            ON CONFLICT(id) DO UPDATE SET
                flow_id = excluded.flow_id,
                campaign_id = excluded.campaign_id,
                step_no = excluded.step_no,
                kind = excluded.kind,
                payload = excluded.payload,
                status = excluded.status,
                run_after = excluded.run_after,
                attempts = excluded.attempts,
                error = excluded.error,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            WHERE COALESCE(excluded.updated_at, 0) > COALESCE(flow_steps.updated_at, 0)
            """,
            row,
        )


def merge_campaign_params(target: sqlite3.Connection, source: sqlite3.Connection) -> None:
    for campaign_id, params, updated_at in source.execute(
        "SELECT campaign_id, params, updated_at FROM campaign_params"
    ):
        target.execute(
            """
            INSERT INTO campaign_params(campaign_id, params, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(campaign_id) DO UPDATE SET
                params = excluded.params,
                updated_at = excluded.updated_at
            WHERE COALESCE(excluded.updated_at, 0) > COALESCE(campaign_params.updated_at, 0)
            """,
            (campaign_id, params, updated_at),
        )


def merge_append_only(
    target: sqlite3.Connection,
    source: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
) -> None:
    placeholders = ", ".join("?" for _ in columns)
    match = " AND ".join(f"{column} IS ?" for column in columns)
    sql = (
        f"INSERT INTO {table}({', '.join(columns)}) "
        f"SELECT {placeholders} WHERE NOT EXISTS "
        f"(SELECT 1 FROM {table} WHERE {match})"
    )
    for row in source.execute(f"SELECT {', '.join(columns)} FROM {table}"):
        target.execute(sql, (*row, *row))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", type=Path)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()

    require_db(args.target)
    require_db(args.source)
    target = sqlite3.connect(str(args.target), timeout=30)
    source = sqlite3.connect(str(args.source), timeout=30)
    try:
        before = counts(target)
        source_counts = counts(source)
        target.execute("PRAGMA busy_timeout=30000")
        target.execute("BEGIN IMMEDIATE")
        merge_settings(target, source)
        merge_flags(target, source)
        merge_jobs(target, source)
        merge_flow_runs(target, source)
        merge_flow_steps(target, source)
        merge_campaign_params(target, source)
        merge_append_only(
            target, source, "audit",
            ("at", "username", "action", "params", "result", "ip"),
        )
        merge_append_only(
            target, source, "logs",
            ("at", "level", "source", "message"),
        )
        target.commit()
        after = counts(target)
        print({
            "target_before": before,
            "source": source_counts,
            "target_after": after,
        })
    except Exception:
        target.rollback()
        raise
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    main()
