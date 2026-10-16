#!/usr/bin/env bash
# KevinBevinX's Community Bot — run detached so it survives the terminal.
#   ./run.sh          start (or restart) the bot
#   ./run.sh status   is it running?
#   ./run.sh stop     kill it
cd "$(dirname "$0")" || exit 1
PIDFILE=data/bot.pid
LOG=/tmp/community-bot.log

case "$1" in
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "running (pid $(cat "$PIDFILE")) — log: $LOG"
    else
      echo "not running"
    fi
    ;;
  stop)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null && rm -f "$PIDFILE" && echo "stopped"
    ;;
  *)
    [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null; sleep 1
    NODE="$HOME/.local/node/bin/node"
    [ -x "$NODE" ] || NODE=$(command -v node)
    setsid nohup "$NODE" index.js > "$LOG" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    sleep 3
    if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "started (pid $(cat "$PIDFILE")) — log: $LOG"
      head -5 "$LOG"
    else
      echo "FAILED — last lines of $LOG:"; tail -8 "$LOG"; rm -f "$PIDFILE"
    fi
    ;;
esac