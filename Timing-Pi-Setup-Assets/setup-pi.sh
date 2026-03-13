#!/bin/bash

# RT Timing - Raspberry Pi Setup Script
# Run this on each Pi to configure display routing and dependencies

set -e

echo "=== RT Timing Pi Setup ==="
echo ""

# ─────────────────────────────────────────
# 1. Install dependencies
# ─────────────────────────────────────────
echo "[1/4] Installing dependencies..."
sudo apt update -y
sudo apt install -y wlr-randr nodejs npm
npm install -g tsx wait-on concurrently

echo "Dependencies installed."
echo ""

# ─────────────────────────────────────────
# 2. Detect displays
# ─────────────────────────────────────────
echo "[2/4] Detecting displays..."

DISPLAYS=$(wlr-randr 2>/dev/null)
echo "$DISPLAYS"
echo ""

DSI_OUTPUT=$(echo "$DISPLAYS" | grep -i "DSI" | awk '{print $1}' | head -1)
HDMI_OUTPUT=$(echo "$DISPLAYS" | grep -i "HDMI" | awk '{print $1}' | head -1)

if [ -z "$DSI_OUTPUT" ]; then
    echo "WARNING: No DSI display detected. Defaulting to DSI-1"
    DSI_OUTPUT="DSI-1"
fi

if [ -z "$HDMI_OUTPUT" ]; then
    echo "WARNING: No HDMI display detected. Defaulting to HDMI-A-2"
    HDMI_OUTPUT="HDMI-A-2"
fi

echo "Touch display: $DSI_OUTPUT"
echo "Monitor: $HDMI_OUTPUT"
echo ""

# ─────────────────────────────────────────
# 3. Configure labwc window rules
# ─────────────────────────────────────────
echo "[3/4] Configuring labwc window rules..."

LABWC_CONFIG="$HOME/.config/labwc/rc.xml"
mkdir -p "$HOME/.config/labwc"

# Check if rc.xml exists
if [ ! -f "$LABWC_CONFIG" ]; then
    echo "Creating new rc.xml..."
    cat > "$LABWC_CONFIG" <<EOF
<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
</openbox_config>
EOF
fi

# Remove any existing windowRules block to avoid duplicates
sed -i '/<windowRules>/,/<\/windowRules>/d' "$LABWC_CONFIG"

# Insert window rules before closing tag
sed -i "s|</openbox_config>|<windowRules>\n  <windowRule identifier=\"rt-timing\">\n    <action name=\"MoveToOutput\">\n      <output>$DSI_OUTPUT</output>\n    </action>\n  </windowRule>\n  <windowRule title=\"Analytics Dashboard\">\n    <action name=\"MoveToOutput\">\n      <output>$HDMI_OUTPUT</output>\n    </action>\n  </windowRule>\n</windowRules>\n</openbox_config>|" "$LABWC_CONFIG"

echo "Window rules written to $LABWC_CONFIG"
echo ""

# ─────────────────────────────────────────
# 4. Apply labwc config
# ─────────────────────────────────────────
echo "[4/4] Applying labwc configuration..."

if labwc --reconfigure 2>/dev/null; then
    echo "labwc reconfigured successfully."
else
    echo "Note: labwc --reconfigure failed (may need a reboot or labwc session to be active)"
fi

echo ""
echo "=== Setup Complete ==="
echo "Touch display ($DSI_OUTPUT) → Main window"
echo "Monitor ($HDMI_OUTPUT) → Analytics window"
echo ""
echo "Run your app with: cd ~/Timing\ Program && npm run application"
