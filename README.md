# Five999 Temporary Voice Channels

A Render-ready Discord bot for Five999 that creates temporary voice channels using a **Join to Create** VC and gives each creator a button-based control panel.

No slash commands are used.

## Features

- Join a permanent `➕ Create Temporary VC` voice channel to create a room.
- Automatically moves the creator into their new room.
- Gives the creator permissions only on their own temporary VC.
- Button control panel in a configured Discord text channel.
- Rename via modal.
- Lock / unlock.
- Set a user limit from 0-99.
- Permit a selected user.
- Remove and deny a selected user.
- Transfer ownership using a Discord user picker.
- Delete the VC manually.
- Automatically deletes a VC once empty.
- Automatically transfers ownership to another connected human member if the owner leaves first.
- Prevents one member creating duplicate rooms.
- Recovers existing tracked rooms after a bot restart.
- Optional logging channel.
- All secrets are configured with Render environment variables.

## Control Panel

Each room gets a panel containing:

- `✏️ Rename`
- `🔒 Lock / 🔓 Unlock`
- `👥 User Limit`
- `✅ Permit User`
- `🚫 Remove User`
- `👑 Transfer Owner`
- `🗑️ Delete`

Anyone who can see the configured control panel channel can see the panels, but **only the current owner of the corresponding VC can use them**. Responses to button actions are ephemeral/private to the person using the panel.

## Discord permissions given to the VC creator

The creator receives a permission overwrite on their temporary voice channel only for:

- View Channel
- Connect
- Speak
- Stream
- Move Members
- Mute Members
- Deafen Members
- Manage Channel

This does **not** give them server-wide moderation permissions. The overwrite disappears when the temporary VC is deleted.

## Requirements

- A Discord bot/application.
- Node.js 24.17.0 or newer.
- A Render Background Worker is recommended.
- A GitHub repository containing these files.

See `INSTALL.md` for the complete setup guide.


## Important Discord permission

The bot role must have **Manage Roles** as well as **Manage Channels**. Discord requires Manage Roles when the bot changes channel permission overwrites for Lock/Unlock, Permit User, Remove User and ownership changes. Place the bot role above normal member roles and explicitly allow Manage Roles for the bot in the temporary VC category if that category uses permission overrides.
