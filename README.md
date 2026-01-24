# RT Technologies Harness Timing Program

## Purpose

Meant to be used on a Raspberry Pi to time harness builds and automatically log build times

## Components

- Frontend - Handles user input and UI updates - Build using React, Vite, and Electron
- Backend - Handles front end database requests using an API - Built using SQLite and Express

## Requirements

- Database path json titled "db-config.json" with a variable called "dbPath"
  