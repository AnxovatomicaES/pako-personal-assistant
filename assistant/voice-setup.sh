#!/usr/bin/env bash
# Voice notes for the owner's assistant, on this Mac: installs whisper.cpp and ffmpeg with Homebrew, downloads a Whisper model, and tells the
# assistant where the model is (ASSISTANT_WHISPER_MODEL in assistant/.env). Everything runs on this computer: no key, no bill, no audio sent anywhere
# except the download of the model itself.
#
#   bash assistant/voice-setup.sh                 # the "small" model (about 470 MB; multilingual: English and many other languages)
#   WHISPER_SIZE=medium bash assistant/voice-setup.sh   # better with names and noise, about 1.5 GB, slower
#
# Testing: ASSISTANT_VOICE_DRY_RUN=1 prints the install and download steps instead of running them (the settings file is still written).

set -euo pipefail
umask 077 # the settings file (it holds the bridge token) and its temporary copy are never readable by other users

SIZE="${WHISPER_SIZE:-small}"
case "$SIZE" in
  tiny | base | small | medium) ;;
  *)
    echo "WHISPER_SIZE must be tiny, base, small or medium." >&2
    exit 1
    ;;
esac

# The assistant's folder, as assistant/bridge.ts finds it: ~/.pako-assistant, or ~/.ai-buyer-assistant (its name from before Pako was called
# Pako) on a Mac that has only that one.
STATE_DIR="${ASSISTANT_STATE_DIR:-}"
if [ -z "$STATE_DIR" ]; then
  STATE_DIR="$HOME/.pako-assistant"
  if [ ! -e "$STATE_DIR" ] && [ -d "$HOME/.ai-buyer-assistant" ]; then STATE_DIR="$HOME/.ai-buyer-assistant"; fi
fi
MODEL="$STATE_DIR/models/ggml-$SIZE.bin"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ASSISTANT_ENV_FILE:-$HERE/.env}"
DRY="${ASSISTANT_VOICE_DRY_RUN:-}"

run() {
  if [ -n "$DRY" ]; then
    echo "[dry run] $*"
  else
    "$@"
  fi
}

if [ -z "$DRY" ] && ! command -v brew > /dev/null 2>&1; then
  echo "Homebrew is needed to install whisper.cpp and ffmpeg (https://brew.sh). Install it, then run this again." >&2
  exit 1
fi

if [ -n "$DRY" ] || ! command -v whisper-cli > /dev/null 2>&1 || ! command -v ffmpeg > /dev/null 2>&1; then
  echo "Installing whisper.cpp and ffmpeg..."
  run brew install whisper-cpp ffmpeg
else
  echo "whisper-cli and ffmpeg are already installed."
fi

if [ -n "$DRY" ] || [ ! -s "$MODEL" ]; then
  echo "Downloading the $SIZE model..."
  run mkdir -p "$STATE_DIR/models"
  run curl -L --fail --progress-bar -o "$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$SIZE.bin"
  run mv "$MODEL.part" "$MODEL"
else
  echo "The $SIZE model is already at $MODEL."
fi

# Tell the assistant where the model is: replace the line if there is one, add it if not. The file stays readable by its owner only.
mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
if grep -q '^ASSISTANT_WHISPER_MODEL=' "$ENV_FILE"; then
  tmp="$ENV_FILE.tmp.$$"
  grep -v '^ASSISTANT_WHISPER_MODEL=' "$ENV_FILE" > "$tmp" || true
  printf 'ASSISTANT_WHISPER_MODEL=%s\n' "$MODEL" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
else
  # A file edited by hand may not end in a newline: add one, so the new line does not join the last one.
  if [ -s "$ENV_FILE" ] && [ -n "$(tail -c 1 "$ENV_FILE")" ]; then printf '\n' >> "$ENV_FILE"; fi
  printf 'ASSISTANT_WHISPER_MODEL=%s\n' "$MODEL" >> "$ENV_FILE"
fi

echo
echo "Done. Restart the assistant so it listens to voice notes:"
# The LaunchAgent's name, or its older one on a Mac whose assistant/install.sh has not run since the rename.
LABEL="local.pako.assistant"
if [ ! -f "$HOME/Library/LaunchAgents/$LABEL.plist" ] && [ -f "$HOME/Library/LaunchAgents/com.aibuyer.assistant.plist" ]; then LABEL="com.aibuyer.assistant"; fi
echo "  launchctl kickstart -k gui/\$(id -u)/$LABEL"
echo "Then send it a voice note on WhatsApp."
