FROM python:3.12-slim

# Install Node.js (required for Claude Code and Codex CLIs) and git (required by agents).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    nodejs \
    npm \
    && rm -rf /var/lib/apt/lists/*

# Install agent runtimes globally (as root, before switching user).
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g @openai/codex

# Claude Code refuses --dangerously-skip-permissions when running as root.
RUN useradd -m -u 1000 hive
USER hive
WORKDIR /home/hive/app

COPY --chown=hive:hive requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=hive:hive . .

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "hive.runner.main:app", "--host", "0.0.0.0", "--port", "8000"]
