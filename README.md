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

# Download and run the setup script
- wget https://raw.githubusercontent.com/Nickanator892/RT-Timing-Program-React/Main/Timing-Pi-Setup-Assets/setup-pi.sh
- chmod +x setup-pi.sh
- ./setup-pi.sh
  
