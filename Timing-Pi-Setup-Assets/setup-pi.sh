#!/bin/bash
set -e

echo "Setting up RT Timing Update Service..."

# Install latest version of the app
echo "Downloading latest RT Timing release..."
DEB_URL=$(curl -s https://api.github.com/repos/Nickanator892/RT-Timing-Program-React/releases/latest | grep browser_download_url | grep .deb | cut -d '"' -f 4)
wget -O /tmp/rt-timing.deb "$DEB_URL"
sudo dpkg -i /tmp/rt-timing.deb

# Set up updater
echo "Setting up updater..."
sudo rm -rf /usr/local/rt-timing-updater
sudo mkdir -p /usr/local/rt-timing-updater
sudo chown $USER:$USER /usr/local/rt-timing-updater
cd /usr/local/rt-timing-updater
git clone https://github.com/Nickanator892/RT-Timing-Program-React .
cd updater
npm install
cd ..

# Fix SQLite: build better-sqlite3 for the SAME runtime that will load it.
# The packaged app spawns its server with the system `node` from PATH (see
# electron/main.js), so the module must match system Node's ABI - building with
# a different Node install (or for Electron) fails at load time with errors
# like "libnode.so.108: cannot open shared object file" or "Module did not
# self-register".
echo "Building better-sqlite3 for system Node - this may take a few minutes..."
cd /usr/local/rt-timing-updater
npm install --omit=dev --no-audit --no-fund
npm rebuild better-sqlite3 --build-from-source
# Prove the binary loads under this exact node before shipping it into the app.
node -p "require('better-sqlite3') && 'better-sqlite3 loads OK'"
sudo cp node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  /opt/rt-timing/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
cd ~

# Set up db-config.json
echo "Setting up database config..."
mkdir -p ~/.config/rt-timing
if [ ! -f ~/.config/rt-timing/db-config.json ]; then
    echo '{
  "dbPath": "/home/nmartens/Timing Program/data/WHPP_Database.db"
}' > ~/.config/rt-timing/db-config.json
fi

# Create systemd service
sudo tee /etc/systemd/system/rt-timing-updater.service > /dev/null << EOF
[Unit]
Description=RT Timing Update Service
After=network.target graphical.target

[Service]
Type=oneshot
User=$USER
WorkingDirectory=/usr/local/rt-timing-updater/updater
ExecStart=/usr/bin/npx tsx /usr/local/rt-timing-updater/updater/update.ts
RemainAfterExit=no
Environment=DISPLAY=:0

[Install]
WantedBy=graphical.target
EOF

sudo systemctl enable rt-timing-updater
sudo systemctl daemon-reload

echo "Setup complete! Run 'sudo systemctl start rt-timing-updater' to launch the app."