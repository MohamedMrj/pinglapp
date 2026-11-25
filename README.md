# Pinglapp

Reminders, notes and a live whiteboard that run in your browser and can be installed as an app. There's no account and no server: everything is saved in your own browser, plus (if you follow the guide below) in a file in your own Google Drive or OneDrive. The only time anything goes over the internet is when you share a whiteboard (see below).

**Open Pinglapp:** https://pinglapp.com/

## First: make sure your data is never lost

Pinglapp saves everything in the browser on your computer. If the computer breaks, you switch computers or the browser's data is cleared, it can disappear. The fix takes five minutes: put Pinglapp's save file in a folder that syncs to the cloud. Pick **one** of the two guides below. Both services are free.

Pinglapp shows the same guide the first time you open it, and you can open it again any time under **Settings → Your data**.

### Option A: Google Drive

1. **Download Google Drive for desktop** (Windows and Mac): https://www.google.com/drive/download/
2. **Install it and sign in.** Open the downloaded file and follow the steps. Sign in with your Google account. If you don't have one, create one for free at https://accounts.google.com/signup.
3. **Find Google Drive on your computer.**
   - Windows: open File Explorer, click **Google Drive** in the left column, then **My Drive**.
   - Mac: open Finder, click **Google Drive** under Locations, then **My Drive**.
4. **Create a folder called `Pinglapp`.** Right-click inside My Drive → **New → Folder** (Mac: **New Folder**).
5. **Make the folder available offline.** Right-click the Pinglapp folder → **Offline access → Available offline**. Pinglapp can then save even without internet, and Google Drive uploads the changes later.

### Option B: OneDrive

1. **Check whether you already have OneDrive.** Windows 10 and 11 have it built in: look for the cloud icon at the bottom right by the clock, or for **OneDrive** in File Explorer's left column. On a Mac, download it from https://www.microsoft.com/microsoft-365/onedrive/download or the App Store.
2. **Sign in.** Open OneDrive (Windows: Start menu → OneDrive) and sign in with your Microsoft account. If you don't have one, create one for free at https://signup.live.com.
3. **Find OneDrive on your computer.**
   - Windows: open File Explorer and click **OneDrive** in the left column (it may be called something like "OneDrive – Personal").
   - Mac: open Finder and click **OneDrive** under Locations.
4. **Create a folder called `Pinglapp`.** Right-click inside the OneDrive folder → **New → Folder** (Mac: **New Folder**).
5. **Keep the folder on this computer.** Right-click the Pinglapp folder → **Always keep on this device**. Pinglapp can then save even without internet, and OneDrive uploads the changes later.

### Then, in Pinglapp

- **Chrome, Edge or Opera:** in the setup (or **Settings → Your data → Create a save file…**), click **Choose a place and save** and pick the `Pinglapp` folder you just made. From then on every change is written to `Pinglapp-data.json` in that folder automatically. The header says **Saved** when both copies are up to date.
- **Firefox, Safari and other browsers** can't keep a save file. Pinglapp reminds you once a week to download a backup: move that file into your `Pinglapp` folder.
- **Using Pinglapp on another computer:** install Google Drive or OneDrive there too and sign in with the same account. In Pinglapp, choose **I already have a save file** and open `Pinglapp/Pinglapp-data.json`. Changes on either computer are merged item by item, so nothing is lost when both were used.
- After a browser restart, the browser may ask once for permission to keep using the file ("Save file needs a click"). That's a browser security rule, not an error; nothing is lost in the meantime.

## Get started
1. Open the link above in Chrome, Edge, Brave, Firefox or Safari.
2. Install it as an app (optional but handy): in Chrome or Edge, click the **Install** icon at the right of the address bar. Pinglapp then gets its own window and taskbar icon.
3. Click **Allow notifications**. You'll get a test notification straight away.
4. Want Pinglapp running all the time? **Settings → Open Pinglapp when the browser starts → Show me how.**

Reminders pop up while Pinglapp is open, so **minimise it instead of closing it**. Anything that fell due while it was closed shows up when you open it again.

Each browser, and each browser profile, keeps its own copy. Use the save file (above) to share one set of reminders and notes between them.

## Quick add
Type in the big box and press **Enter**. English and Swedish both work.

| You type | You get |
|---|---|
| `Call Anna tomorrow 10:00` | Tomorrow at 10:00 |
| `Stretch in 45 min` / `om 2 timmar kolla mejlen` | Relative times |
| `möte på torsdag kl 13` / `pay rent 25/11` | Days and dates |
| `Deploy check 14:00 UTC` | UTC, converted to your local time |
| `Check pipeline every 30 min` | Repeats every 30 minutes |
| `Standup every weekday kl 9` | Repeats Monday to Friday |
| ``Standup cron `45 8 * * 1-5` `` | Cron schedule |
| `#etl #prod` | Tags (click a tag to filter) |
| `!` `!!` `!!!` or `p1` | Priority: low, medium, high |

**Ctrl+Enter** saves what you typed as a note. Press **?** in Pinglapp to see all keyboard shortcuts.

## Features
- **Alerts:** a system notification, a box in the Pinglapp window with Done / Snooze / Edit, and a sound. Sound, colour, size and position can be changed under Settings.
- **Keep Pinglapp on top** (Chrome and Edge): a small window that floats above your other windows.
- **Outlook:** the **Outlook** button downloads a calendar entry. Open it and click Save & Close, and Outlook reminds you on your phone too.
- **Notes:** one view: the note is always shown formatted, and the part you click opens in place as Markdown, so there is no switching between editing and reading. Drag across the text to select and copy any piece of it. Arrow keys move from part to part, Esc shows it all formatted again, checkboxes tick with one click, and Ctrl+click opens a link. Coloured code blocks, `- [ ]` checklists, tables, pictures, templates, version history and a trash that keeps deleted notes for 30 days.
- **Themes:** twelve themes, each with a light and a dark version that follow the light/dark mode (or your computer's setting): Lagoon, Fjord, Solarized, Sunset, Forest, Candy, Neon, Space, Interstellar, Nature, Mountain and Desert. Most have a subtle decoration on the page background, such as stars, pines, mountains or dunes. The whiteboard follows the theme too. Choose under **Settings** (the gear icon) → Look and feel. Swedish or English.
- **Your data:** a save file (see above), downloadable backups, restore, CSV export, and an automatic copy each day for the last 14 days.

## Whiteboard
The **Whiteboard** tab is an endless canvas you can use alone or with others.

- **Draw and write:** pen, highlighter, eraser, rectangles, ellipses, diamonds, triangles, lines, arrows, text, sticky notes and pictures (paste, drag in, or the picture tool). Select, move, resize, lock, duplicate, bring to front, and undo/redo everything.
- **Smart shapes (✨):** a rough circle, box, triangle, diamond, line or arrow drawn with the pen becomes a clean shape. Ctrl+Z brings back what you drew. Lines and arrows snap to shapes and stay attached when the shapes move.
- **Mind maps:** select a sticky note or shape and press **Tab** for a new branch, **Enter** for a sibling.
- **Templates:** retrospective, kanban, SWOT, flowchart, mind map and brainstorm.
- **Fullscreen and more room:** the fullscreen button at the top right (or **F**) gives the board the whole screen. Esc or the button exits. The list of your boards hides in fullscreen. **B**, or the panel button at the top left, shows or hides it any time.
- **Dark mode:** in dark mode the board turns dark too. Ink becomes lighter and sticky notes deeper and softer, so everything stays readable. The colours are only shown differently: exports and shared boards keep the normal colours, and a guest in light mode sees the board in light.
- **Export:** a PNG picture, print or save as PDF, or a board file you can open again later. Boards are saved on your computer and included in **Download backup**.

### Sharing a board live
1. Click **Share**, type your name and click **Start sharing and make a link**.
2. Send the link to the people you want to invite. They open it, type a name and click **Join**. They don't need Pinglapp or an account.
3. Everyone sees everything live: drawing as it's drawn, notes as they're typed, items as they're dragged, and everyone's mouse pointer with their name.

What the host controls (in the Share window):
- **Who can edit:** everyone who joins, only the people you allow, or nobody (view only). You can also change it per person, or remove someone from the board.
- Whether guests may move and delete other people's items, add pictures, use the laser pointer, and download the board.
- **Waiting room:** you let each person in.
- **Everyone follows my view:** you lead the session. **Bring everyone to me** does it once.
- **Make a new link** shuts out everyone who had the old one.

Facilitation tools for the host: a countdown timer everyone sees, and secret dot voting on sticky notes (3, 5 or 10 votes each), with the results revealed at the end. Guests can follow the host's view, and anyone can use the laser pointer (K) when it's allowed.

How it works, and privacy: the host's browser is the meeting place. A free public service ([PeerJS](https://peerjs.com)) only helps the browsers find each other. The drawings then go directly between the browsers, encrypted. On networks that block direct connections, the encrypted data passes through PeerJS's relay, which can't read it. Nothing is stored anywhere else, and the board is live only while the host has it open. Anyone with the link can ask to join, so share it only with the people you mean, or use the waiting room.

## For maintainers
Pinglapp is one static `index.html`, plus `manifest.webmanifest`, `sw.js` (offline support) and two icons. There's no build step: edit `index.html` and push, and everyone gets the update the next time they open Pinglapp.

The only external file is PeerJS 1.5.5, loaded from jsDelivr with a Subresource Integrity hash, and only when someone shares or joins a whiteboard. Everything else works offline.

Storage keys (`reminder-by-me.v1` in localStorage, the `reminder-by-me` IndexedDB database) keep their old names on purpose. Renaming them without a migration would make everyone's reminders disappear.

### Tests
The `tests/` folder holds the test suite. It isn't needed to run Pinglapp.

```sh
cd tests
npm install        # once: installs playwright-core
npm test           # everything
npm run test:unit  # fast Node-only tests: sync merge, quick-add parser, whiteboard model, code colours, code suggestions
npm run test:app   # the real page in a headless browser, including a whiteboard host and guests
```

The browser tests use Playwright's Chromium if it's installed (`npx playwright install chromium`), otherwise Microsoft Edge. Set `PING_BROWSER` to a browser executable to choose another one. The whiteboard tests connect the host and guests through a local stand-in for PeerJS (`window.PING_WB_LOCAL`), so they need no internet.
