# Five999 Temp VC Bot — Installation Guide

## 1. Create the Discord channels

In the Five999 Discord server, create or choose:

1. A category for temporary voice channels, for example:
   `TEMPORARY VOICE CHANNELS`

2. A permanent voice channel users join to create a room, for example:
   `➕ Create Temporary VC`

3. A text channel for the room control panels, for example:
   `#vc-control-panels`

4. Optional: a text channel for bot logs, for example:
   `#temp-vc-logs`

The `➕ Create Temporary VC` channel can sit inside the same category as the temporary rooms or elsewhere. The temporary rooms themselves are created inside the category configured by `TEMP_CATEGORY_ID`.

---

## 2. Enable Discord Developer Mode and copy the IDs

In Discord:

1. Open **User Settings**.
2. Go to **Advanced**.
3. Enable **Developer Mode**.
4. Right-click the Five999 server and choose **Copy Server ID**.
5. Right-click `➕ Create Temporary VC` and choose **Copy Channel ID**.
6. Right-click the temporary VC category and choose **Copy Category ID**.
7. Right-click the control-panel text channel and choose **Copy Channel ID**.
8. If using logging, copy the log channel ID as well.

You will enter these on Render later.

---

## 3. Create the Discord bot

1. Go to the **Discord Developer Portal**.
2. Click **New Application**.
3. Name it something such as `Five999 Temp VC`.
4. Open the application and select **Bot**.
5. Create/reset the bot token and copy it somewhere secure.
6. Never place the token in GitHub or inside the bot files.

### Required Gateway Intent

On the bot page, enable:

- **Server Members Intent**

The bot uses guild member information for ownership, user selectors and automatic ownership transfers.

---

## 4. Invite the bot to Five999

In the Discord Developer Portal:

1. Go to **OAuth2** -> **URL Generator**.
2. Select the scope:
   - `bot`
3. Give the bot these permissions:
   - View Channels
   - Manage Channels
   - Move Members
   - Mute Members
   - Deafen Members
   - Send Messages
   - Embed Links
   - Read Message History
4. Open the generated invite URL.
5. Add the bot to the Five999 Discord server.

### Important role position

Place the bot's Discord role high enough that it can manage the temporary channels and move members as required.

You do **not** need to give the bot Administrator if the permissions above are correctly configured.

---

## 5. Upload the bot to GitHub

Extract the ZIP provided by ChatGPT.

Create a new GitHub repository, for example:

`five999-tempvc`

Upload the contents of the extracted folder so the root of the repository contains:

```text
five999-tempvc/
├── src/
│   └── index.js
├── .env.example
├── .gitignore
├── package.json
├── render.yaml
├── README.md
└── INSTALL.md
```

Do not create a `.env` file containing the real bot token in GitHub.

---

## 6. Deploy on Render

A Discord bot should run continuously, so use a **Background Worker** on Render.

### Option A — use the Render Blueprint

Because this project contains `render.yaml`:

1. Log in to Render.
2. Connect your GitHub account if required.
3. Create a new **Blueprint**.
4. Select your `five999-tempvc` repository.
5. Render should detect the worker configuration.
6. Add the required environment variables when prompted.

### Option B — create the worker manually

Create a **Background Worker** and use:

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

---

## 7. Add the Render environment variables

In the Render service, open **Environment** and add:

### DISCORD_TOKEN
Your Discord bot token.

Example:

```text
DISCORD_TOKEN=your_bot_token
```

### GUILD_ID
The Five999 Discord server ID.

```text
GUILD_ID=123456789012345678
```

### CREATE_VC_ID
The ID of `➕ Create Temporary VC`.

```text
CREATE_VC_ID=123456789012345678
```

### TEMP_CATEGORY_ID
The category where the new temporary voice channels should be created.

```text
TEMP_CATEGORY_ID=123456789012345678
```

The text channel where the owner control panels should be posted.

```text
```

### LOG_CHANNEL_ID
Optional. The text channel to receive creation/deletion/ownership logs.

```text
LOG_CHANNEL_ID=123456789012345678
```

If you do not want logging, leave `LOG_CHANNEL_ID` unset.

### DEFAULT_USER_LIMIT
The initial room limit.

```text
DEFAULT_USER_LIMIT=0
```

`0` means unlimited.

### TEMP_VC_PREFIX
The prefix used for generated VC names.

```text
TEMP_VC_PREFIX=🔊
```

A generated room will look similar to:

`🔊 Max's VC`

---

## 8. Deploy the service

Once the environment variables are configured, deploy/redeploy the Render worker.

In the Render logs you should see messages similar to:

```text
[READY] Logged in as Five999 Temp VC#0000
[READY] Connected to Five999 (...)
[RECOVERY] Tracking 0 temporary voice channel(s).
```

If Render reports a missing environment variable, check the spelling of the variable in the Environment section.

---

## 9. Test it

1. Join `➕ Create Temporary VC`.
2. The bot should create a new room named after you.
3. The bot should automatically move you into it.
4. A Five999 control panel should appear in the configured text channel.
5. Try **Rename**.
6. Try **Lock** and **Unlock**.
7. Try **User Limit**.
8. Have another test user join and try **Remove User**.
9. Test **Transfer Owner** while another user is connected.
10. Leave the room empty and confirm it is deleted automatically.

---

## How ownership works

The creator receives channel-specific permissions on the generated VC. `Manage Channel` is included in the creator overwrite and is also used by the bot to identify the owner if the bot restarts.

If the owner leaves while other people are still connected, ownership automatically transfers to the first remaining non-bot member.

If the final person leaves, the voice channel and its control panel are deleted.

---

## Locking a VC

When the owner presses **Lock**, the bot denies `Connect` to `@everyone` on that temporary VC.

The owner can then use **Permit User** to grant a selected person explicit access.

Pressing **Unlock** removes the `@everyone` Connect denial so normal access resumes.

---

## Security notes

- Never publish `DISCORD_TOKEN`.
- Keep all secret values in Render Environment Variables.
- Do not give the VC owner a Discord server role with global `Manage Channels` permissions.
- The bot gives owners a channel-specific permission overwrite only.
- The control-panel code checks the owner's Discord user ID on every interaction.
- A user cannot transfer ownership to somebody who is not currently connected to that room.

---

## Updating the bot later

Make changes to the GitHub repository and push/commit them. If Render automatic deploys are enabled, Render will redeploy the worker automatically.

Existing temporary rooms can be recovered after a normal bot restart because ownership is stored in the channel permission overwrite itself.

---

## Troubleshooting

### The bot is online but nothing happens when I join Create Temporary VC

Check:

- `CREATE_VC_ID` is the correct voice channel ID.
- `GUILD_ID` is the correct server ID.
- The bot has **Manage Channels** and **Move Members**.
- The bot's role is positioned correctly.
- **Server Members Intent** is enabled in the Developer Portal.

### The VC creates but I am not moved into it

The bot normally does not have enough permission to move the member. Check **Move Members** and the bot role/category permissions.

### The control panel does not appear

Check:

- The bot can View Channel, Send Messages, Embed Links and Read Message History there.

### Lock works but somebody can still join

That user might have another Discord role with an explicit channel permission or a user-specific overwrite. Review the category/voice-channel permissions.

### Render says Node version is unsupported

This project requests Node.js 24.17.0 or newer through `package.json`, matching the current discord.js 14.27.0 requirements documented by discord.js.
