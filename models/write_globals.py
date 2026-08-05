"""
Persist a fitted parameter set to Neon and make it the active one.

    python models/write_globals.py                       # from the default json
    python models/write_globals.py --params path.json

Rows are append-only and versioned. Activation is a single transaction that
deactivates the previous row and activates the new one, so a device polling
GET /params mid-write sees one or the other, never neither.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import func, select, text, update

from backend.db import async_session_maker, engine
from backend.models import GlobalParams

SCHEMA_SQL = Path(__file__).parent.parent / "backend" / "schema.sql"


async def ensure_schema() -> None:
    """Apply backend/schema.sql. Idempotent; stands in for migration tooling."""
    # Strip line comments before splitting: a ';' inside a comment is not a
    # statement boundary, and splitting on it produces prose fed to the server.
    sql = "\n".join(
        line.split("--")[0] for line in SCHEMA_SQL.read_text().splitlines()
    )
    async with engine.begin() as conn:
        for statement in filter(None, (s.strip() for s in sql.split(";"))):
            await conn.execute(text(statement))


async def write_params(params: dict) -> int:
    await ensure_schema()

    async with async_session_maker() as session:
        current = (await session.execute(select(func.max(GlobalParams.version)))).scalar()
        version = (current or 0) + 1

        # Deactivate first: the partial unique index allows only one active row,
        # so inserting an active row before clearing the old one would conflict.
        await session.execute(
            update(GlobalParams).where(GlobalParams.is_active).values(is_active=False)
        )
        session.add(
            GlobalParams(
                version=version,
                sigma=params["sigma"],
                z_global=params["z_global"],
                a=params["a"],
                b=params["b"],
                kappa=params["kappa"],
                threshold=params["threshold"],
                encoder_version=params["encoder_version"],
                metrics=params.get("metrics"),
                n_pages=params.get("n_pages"),
                n_labels=params.get("n_labels"),
                n_users=params.get("n_users"),
                is_active=True,
            )
        )
        await session.commit()

    return version


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--params",
        default=str(Path(__file__).parent / "checkpoints" / "global_params.json"),
    )
    args = ap.parse_args()

    with open(args.params) as f:
        params = json.load(f)

    version = await write_params(params)
    m = params.get("metrics", {})
    print(
        f"Activated global_params version {version} "
        f"(encoder {params['encoder_version']}, "
        f"cold-start AUC {m.get('cold_start_auc', float('nan')):.4f}, "
        f"personalized AUC {m.get('personalized_auc', float('nan')):.4f})"
    )


if __name__ == "__main__":
    asyncio.run(main())
