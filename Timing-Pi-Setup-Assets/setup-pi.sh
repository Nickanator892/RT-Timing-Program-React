#!/bin/bash
echo "Setting up RT Timing Update Service..."
sudo mkdir -p /usr/local/rt-timing-updater
cd /usr/local/rt-timing-updater
sudo git clone https://github.com/Nickanator892/RT-Timing-Program-React .
npm install

sudo tee /etc/systemd/system/rt-timing-updater.service > /dev/null << EOF
[Unit]
Description=RT Timing Update Service
After=network.target graphical.target

[Service]
Type=oneshot
User=$USER
WorkingDirectory=/usr/local/rt-timing-updater
ExecStart=/usr/bin/npx tsx /usr/local/rt-timing-updater/updater/update.ts
RemainAfterExit=no
Environment=DISPLAY=:0

[Install]
WantedBy=graphical.target
EOF

sudo systemctl enable rt-timing-updater
sudo systemctl daemon-reload
echo "Setup complete! Run 'sudo systemctl start rt-timing-updater' to update and launch the app."