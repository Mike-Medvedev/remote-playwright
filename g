"In my Playwright script, I need to implement a browser profile copy strategy to work around Azure File Share SMB limitations.
Before launching the browser, copy the entire contents of /data/browser-profile to /tmp/browser-profile using fs.cpSync recursively. If /data/browser-profile doesn't exist yet, just create /tmp/browser-profile with fs.mkdirSync.
Launch the persistent browser context using /tmp/browser-profile as the profile directory instead of /data/browser-profile.
After the script finishes all its work and before it exits, copy /tmp/browser-profile back to /data/browser-profile using fs.cpSync recursively.
Keep all existing logic intact, just change the profile directory and add the copy steps at the start and end."