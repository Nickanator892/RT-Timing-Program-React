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

# Fix SQLite
echo "Building SQLite for Electron arm64 - this may take a few minutes..."
mkdir -p ~/better-sqlite3-build
cd ~/better-sqlite3-build
npm install better-sqlite3 --build-from-source
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