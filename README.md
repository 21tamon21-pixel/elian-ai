# Elian AI

A voice-first personal AI assistant built for Trevon.

## Current foundation
- Groq-powered conversational AI
- Elian personality and identity
- Trevon user identity
- Browser speech recognition
- Browser speech synthesis
- Animated voice interface
- Conversation interruption controls
- Daily prompt counter and break reminder
- Configurable backend prompt limit

## Requirements
- Python 3.10+
- Groq API key
- Modern browser with microphone support

## Installation

Create a virtual environment:

python -m venv .venv

Activate it:

Linux/macOS:
source .venv/bin/activate

Windows:
.venv\Scripts\activate

Install dependencies:

pip install -r requirements.txt

Copy environment configuration:

cp .env.example .env

Add your Groq API key to .env.

Start Elian:

uvicorn app.main:app --reload

Open:

http://127.0.0.1:8000

## Security
Never commit .env or expose API keys in frontend JavaScript.

## Roadmap
1. Improved voice recognition
2. Dedicated always-on microphone service
3. Wake-word detection
4. Better speech interruption and continuation
5. Persistent conversation memory
6. Calendar and reminder integrations
7. Analysis and research tools
8. Desktop application
9. Raspberry Pi hardware deployment
