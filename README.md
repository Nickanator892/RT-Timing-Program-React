# RT Technologies Harness Timing Program

## Purpose

Meant to be used on a Raspberry Pi to time harness builds and automatically log build times

## Components

- Frontend - Handles user input and UI updates - Built using React, Vite, and Electron
- Backend - Handles front end database requests using an API - Built using SQLite and Express

## Requirements

- Database path json titled "db-config.json" with a variable called "dbPath"
- Settings.json file to store users and pause reasons

## Setup

- Run setup script on Pi from the Timing-Pi-Setup-Assets file using the command chmod +x setup-pi.sh
  
