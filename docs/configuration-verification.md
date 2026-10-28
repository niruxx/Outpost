# Per-instance configuration regression checks

Run `npm ci` and `npm run build` before these checks. Use a disposable Minecraft Java instance with a generated server.properties file.

1. Open Configuration, change the name, memory, port, bind IP, and restart policy. Wait at least ten seconds. Confirm every draft value remains. Save, navigate away and back, and confirm persistence.
2. Confirm a saved General port appears as server-port in File Management. Change server-port in the properties editor, save, and confirm the General port after reopening Configuration.
3. Start the instance. Change difficulty to easy, gamemode to creative, white-list to true, and player-idle-timeout to 15. Save. Confirm the response identifies live commands, inspect Console for success, and query difficulty/defaultgamemode/whitelist in the console. Default gamemode affects the server default, not every existing player's mode.
4. Change motd alongside a live setting. Confirm the feedback identifies motd as requiring the next start. Restart, reopen Configuration, and check both values persisted.
5. Stop the instance and save a property. Confirm it is reported as applying on next start and survives a start.
6. Add an existing property key with a different value. Confirm only one row appears and the saved value is displayed. Edit an existing value to an empty string and confirm it saves.
7. Repeat property saves on Bedrock. Confirm values persist and feedback requires the next start; Java commands must not be sent.
8. Submit an array, a non-string property value, a newline in a value, or an invalid port to the properties endpoint. Confirm HTTP 400 and no file changes. Confirm a user without settings permission cannot save.

Build and live-server checks require Node.js/npm and a running Outpost installation; they were unavailable in the editing environment.
