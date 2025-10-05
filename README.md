# Expire Chats

A SillyTavern extension for automatic chat data retention management.

## Overview

This extension automatically deletes chats and optionally backups older than a
specified number of days, helping you manage storage and maintain data retention
policies.

## ⚠️ Warning

**This extension PERMANENTLY deletes expired chats and backups.** There is no
recovery option once data is deleted. Always maintain external backups of
important conversations before enabling this extension.

**Software bugs in this extension could potentially delete more data than
intended.** While care has been taken to prevent this, no software is completely
bug-free. Keep external backups of all important data.

## Installation

1. Open SillyTavern
2. Navigate to Extensions > Click "Install extension"
3. Use the following URL: `https://github.com/Christoph-D/expire-chats`

## Usage

### Initial Setup

1. Navigate to Extensions > Open "Expire chats"
2. Set the expiration time in days
3. Configure optional settings:
   - **Expire backups**: Also delete expired chat backups
   - **Auto-expire**: Automatically run on page load

### Manual Expiration

Click the **"Expire now"** button in the extension settings to immediately
expire old chats/backups. A preview dialog will show which chats/backups will be
deleted, giving you a chance to cancel before any data is removed.

### Automatic Expiration

Enable **"Auto-expire"** in the settings to automatically expire chats/backups
on every page load.

⚠️ **Warning**: When auto-expire is enabled, expiration happens **WITHOUT
CONFIRMATION**. Ensure your settings are correct before enabling this option.

## Features

- Expires chats after a configurable number of days since their last message
- Supports both character chat and group chat deletion
- Optional backup deletion
- Optionally runs in the background without user interaction
- The currently open chat is never deleted

## License

This extension is licensed under the AGPL-3.0 license.
