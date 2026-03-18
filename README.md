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

## Updates

To update software, run the built in updater from the settings tab and wait for the terminal to complete the task. The terminal should automatically open the app after the update. Check the version after to ensure update was successful. The update might take a few minutes, wait at least 4 minutes before getting help. 