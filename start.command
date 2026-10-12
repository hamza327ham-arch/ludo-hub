#!/bin/bash
cd "$(dirname "$0")"
(sleep 2; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1) &
node server.js
