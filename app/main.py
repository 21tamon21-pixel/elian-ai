import asyncio
import sqlite3
from collections import deque
from datetime import date
from time import monotonic

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.brain import ask_elian
from app.config import (
    ELIAN_DAILY_PROMPT_LIMIT,
    ELIAN_REQUESTS_PER_MINUTE,
)

app = FastAPI(title="Elian AI")

DB_PATH = "elian.db"
request_times = deque()
rate_lock = asyncio.Lock()


def init_db():
    with sqlite3.connect(DB_PATH) as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS usage (
                day TEXT PRIMARY KEY,
                prompts INTEGER NOT NULL DEFAULT 0
            )
        """)


init_db()


class ChatRequest(BaseModel):
    messages: list[dict]


async def wait_for_request_slot():
    """Wait until a rolling 60-second request slot is available."""
    while True:
        async with rate_lock:
            now = monotonic()

            while request_times and now - request_times[0] >= 60:
                request_times.popleft()

            if len(request_times) < ELIAN_REQUESTS_PER_MINUTE:
                request_times.append(now)
                return

            wait_seconds = max(
                0.5,
                60 - (now - request_times[0]) + 0.1
            )

        await asyncio.sleep(wait_seconds)


def get_daily_count(day):
    with sqlite3.connect(DB_PATH) as db:
        row = db.execute(
            "SELECT prompts FROM usage WHERE day = ?",
            (day,)
        ).fetchone()
    return row[0] if row else 0


def reserve_daily_request(day):
    """Reserve a daily request atomically to prevent concurrent overuse."""
    with sqlite3.connect(DB_PATH, timeout=30) as db:
        db.execute("BEGIN IMMEDIATE")

        db.execute("""
            INSERT OR IGNORE INTO usage(day, prompts)
            VALUES (?, 0)
        """, (day,))

        count = db.execute(
            "SELECT prompts FROM usage WHERE day = ?",
            (day,)
        ).fetchone()[0]

        if count >= ELIAN_DAILY_PROMPT_LIMIT:
            db.rollback()
            return None

        db.execute(
            "UPDATE usage SET prompts = prompts + 1 WHERE day = ?",
            (day,)
        )
        db.commit()

        return count + 1


def release_daily_request(day):
    """Undo a reservation if the AI request fails."""
    with sqlite3.connect(DB_PATH) as db:
        db.execute("""
            UPDATE usage
            SET prompts = MAX(0, prompts - 1)
            WHERE day = ?
        """, (day,))


@app.get("/api/status")
async def status():
    today = date.today().isoformat()
    count = get_daily_count(today)

    async with rate_lock:
        now = monotonic()

        while request_times and now - request_times[0] >= 60:
            request_times.popleft()

        used_this_minute = len(request_times)
        next_slot_seconds = (
            max(0, round(60 - (now - request_times[0]), 1))
            if used_this_minute >= ELIAN_REQUESTS_PER_MINUTE
            else 0
        )

    return {
        "assistant": "Elian",
        "owner": "Trevon",
        "prompts_today": count,
        "daily_limit": ELIAN_DAILY_PROMPT_LIMIT,
        "remaining": max(0, ELIAN_DAILY_PROMPT_LIMIT - count),
        "limit_reached": count >= ELIAN_DAILY_PROMPT_LIMIT,
        "requests_this_minute": used_this_minute,
        "minute_limit": ELIAN_REQUESTS_PER_MINUTE,
        "next_slot_seconds": next_slot_seconds,
    }


@app.post("/api/chat")
async def chat(request: ChatRequest):
    if not request.messages:
        raise HTTPException(400, "A message is required.")

    last = request.messages[-1]

    if last.get("role") != "user":
        raise HTTPException(400, "Last message must be from user.")

    if not isinstance(last.get("content"), str) or not last["content"].strip():
        raise HTTPException(400, "Message cannot be empty.")

    # Wait instead of repeatedly sending requests when the minute limit is full.
    await wait_for_request_slot()

    today = date.today().isoformat()
    count = reserve_daily_request(today)

    if count is None:
        raise HTTPException(
            429,
            "Elian's daily allowance has been used. It resets tomorrow."
        )

    try:
        reply = await ask_elian(request.messages)

    except httpx.HTTPStatusError as error:
        release_daily_request(today)

        provider_response = error.response
        provider_message = provider_response.text[:1500]
        retry_after = provider_response.headers.get("retry-after", "0")

        if provider_response.status_code == 429:
            raise HTTPException(
                429,
                detail={
                    "message": "Groq has temporarily rate-limited this request.",
                    "provider_detail": provider_message,
                    "retry_after": retry_after,
                    "retryable": True,
                },
                headers={"Retry-After": retry_after}
            )

        raise HTTPException(
            502,
            f"Groq returned an error: {provider_message}"
        )

    except Exception as error:
        release_daily_request(today)
        raise HTTPException(502, f"AI service error: {error}")

    return {
        "reply": reply,
        "prompts_today": count,
        "daily_limit": ELIAN_DAILY_PROMPT_LIMIT,
        "remaining": max(0, ELIAN_DAILY_PROMPT_LIMIT - count),
        "break_reminder": False,
    }


app.mount("/", StaticFiles(directory="web", html=True), name="web")
