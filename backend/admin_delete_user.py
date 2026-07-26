"""
Delete users by email, along with their labels and any page nobody else labels.

Dry run (default — shows what would go, changes nothing):
    python -m backend.admin_delete_user someone@example.com

Actually delete:
    python -m backend.admin_delete_user someone@example.com --yes

Run from the repo root so the `backend` package resolves and .env is picked up.
This talks to the database directly; the API server does not need to be running.
"""

import argparse
import asyncio

from sqlalchemy import delete, select

from .db import async_session_maker
from .models import Page, PageLabel, User
from .pages import _collect_orphans


async def _describe(session, user: User) -> tuple[list, list]:
    """Return (labels, pages_that_would_be_orphaned) for a user."""
    labels = list(
        (
            await session.execute(
                select(PageLabel.page_id, PageLabel.label, Page.url)
                .join(Page, PageLabel.page_id == Page.id)
                .where(PageLabel.user_id == user.id)
            )
        ).all()
    )
    page_ids = [row.page_id for row in labels]

    orphans = []
    if page_ids:
        # A page survives if any *other* user still labels it.
        shared = set(
            (
                await session.execute(
                    select(PageLabel.page_id)
                    .where(PageLabel.page_id.in_(page_ids), PageLabel.user_id != user.id)
                    .distinct()
                )
            )
            .scalars()
            .all()
        )
        orphans = [row for row in labels if row.page_id not in shared]

    return labels, orphans


async def main(emails: list[str], commit: bool) -> None:
    async with async_session_maker() as session:
        for email in emails:
            user = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one_or_none()

            if user is None:
                print(f"\n{email}: no such user")
                continue

            labels, orphans = await _describe(session, user)

            print(f"\n{email}")
            print(f"  user id:    {user.id}")
            print(f"  google_sub: {user.google_sub}")
            print(f"  verified:   {user.is_verified}   active: {user.is_active}")
            print(f"  labels:     {len(labels)}")
            for row in labels:
                shared = "" if row in orphans else "   (kept — another user labels it)"
                print(f"    - [{row.label}] {row.url}{shared}")
            print(f"  pages to delete (+ their R2 objects): {len(orphans)}")

            if not commit:
                continue

            page_ids = [row.page_id for row in labels]
            await session.execute(delete(PageLabel).where(PageLabel.user_id == user.id))
            await session.flush()
            deleted_pages = await _collect_orphans(session, page_ids)
            await session.delete(user)
            await session.commit()
            print(f"  DELETED: user, {len(labels)} label(s), {deleted_pages} page(s)")

    if not commit:
        print("\nDry run — nothing was changed. Re-run with --yes to delete.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Delete users and their data by email.")
    ap.add_argument("emails", nargs="+")
    ap.add_argument("--yes", action="store_true", help="actually delete (default is a dry run)")
    args = ap.parse_args()
    asyncio.run(main(args.emails, commit=args.yes))
