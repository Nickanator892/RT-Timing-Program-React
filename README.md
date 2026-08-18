# RT Technologies Harness Timing Program

## Purpose

Meant to be used on a Raspberry Pi to time and track harness tasks such as builds, braiding, pre-builds, setup, teardown, etc.

## Components

- Frontend - Handles user input and UI updates - Built using React, Vite, and Electron
- Backend - Handles front end database requests using an API - Built using SQLite and Express

## Requirements

- Database path json titled "db-config.json" with a variable called "dbPath." This is created by the installer

## Setup

Execute the following command in a new terminal

wget https://raw.githubusercontent.com/Nickanator892/RT-Timing-Program-React/Main/Timing-Pi-Setup-Assets/setup-pi.sh 
chmod +x setup-pi.sh 
./setup-pi.sh

Search for "rt-timing" in the start menu on the RPi

Upon launch, you will be prompted to input a database path, you will have to ask for this path.

## Database over a network share (SMB/CIFS)

When dbPath points at a WHPP Database shared from a Windows machine, the mount options matter - a default CIFS mount presents every file as owned by root, so the app can read but every write fails with "attempt to write a readonly database".

The /etc/fstab entry needs ownership mapped to the user that runs the app, writable modes, and `nobrl` (SQLite's locking does not work over CIFS byte-range locks - without it you get intermittent "database is locked" errors):

```
//SERVER/whpp  /home/pi/winshare  cifs  credentials=/home/pi/.smbcredentials,vers=3.0,uid=1000,gid=1000,file_mode=0664,dir_mode=0775,nobrl,_netdev  0  0
```

Replace uid/gid with the output of `id -u` / `id -g` for the app's user. After editing, `sudo umount <mountpoint> && sudo mount -a`, then verify with `touch <mountpoint>/writetest && rm <mountpoint>/writetest`.

Note: `nobrl` means SQLite locks are not enforced between this Pi and other writers of the same file (e.g. the Harness Pricing Program on the host). Light concurrent use is fine; if more stations are added, prefer running the Express server on the host machine and pointing frontends at it over HTTP instead of mounting the file.

## Updates

To update software, run the built in updater from the settings tab and wait for the terminal to complete the task. The terminal should automatically open the app after the update. Check the version after to ensure update was successful. The update might take a few minutes, wait at least 4 minutes before getting help. 