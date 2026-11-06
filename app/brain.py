import httpx
from app.config import (
    GROQ_API_KEY, GROQ_MODEL, SYSTEM_PROMPT
)

async def ask_elian(messages):
    if not GROQ_API_KEY:
        raise RuntimeError("Groq API key is missing.")

    payload = {
        "model": GROQ_MODEL,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *messages[-20:]
        ],
        "temperature": 0.7,
        "max_tokens": 1200
    }

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json"
            },
            json=payload
        )

        response.raise_for_status()
        data = response.json()

    return data["choices"][0]["message"]["content"]
