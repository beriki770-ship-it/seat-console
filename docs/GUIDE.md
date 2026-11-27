# How to use the Seat Console

_Verified: 2026-11-21_

Short answers to the things you do most. Button names are written as they appear on the page. The same text is in the console: **Guide** at the top of the sidebar (`#guide`), in all 15 languages.

Every section there has a **Show me** button: the Guide closes and the console points at the real buttons one at a time (**Back**, **Next**, Esc to stop). **Take the full tour** runs the main ones in a row. A fresh install asks once whether you want the tour.

## What does the sidebar show?

Each seat is one AI account with its own chats. Its row shows the name, how much of the 5-hour window and of the week is used, and how many chats are working or wait on you. The arrow in front of the name opens the details: email, role, when each window resets, and any free limit reset with a **Use** button, which asks before it spends anything. **All** shrinks every seat to its row and the chats that need you.

## How do I start a chat?

Press **+ new** next to a seat and type the task in the box at the bottom. Enter sends, Shift+Enter adds a line. Below the box you pick the working folder, the permission mode, the model and the **effort** slider. **auto** lets routine actions run on their own, **ask** shows an approval card before the AI edits files or runs commands, and **bypass** runs everything without asking.

## Which folder does a new chat open in?

The **Project: auto** button next to the folder field shows it. Press it to pick a project, or leave it on automatic: the chat then opens in the one project your first message names (a path like seats/docs or the project's name), and in the projects folder when it names none or several. **New chat here** always uses its project's folder.

## How do I send a file, or stop a turn?

**Attach** adds images or files. You can also paste an image straight into the message box. **Stop** ends the turn that is running. The chat stays, and your next message picks it up again.

## How do I speak instead of typing?

Press the microphone next to **Send** and talk: the words appear in the box while you speak. Press it again to stop. Nothing is sent until you send it, and Esc or sending also stops it. On a computer you can hold Ctrl+Space while you talk and let go to stop. The **Live** engine (the default) uses the browser's speech service, Google in Chrome and Microsoft in Edge. **Private** keeps the audio on this server and writes the text a few seconds after you stop; Firefox always uses it. Voice works only on the https address, and the browser asks once for the microphone. Engine, model and language: **Voice** in Settings.

## How do I run a skill, or reuse text I type often?

Type `/` in the message box and the seat's skills and commands show up. Keep typing to narrow the list, then press Enter or tap one: it goes in as `/name`, and you can write more after it. Type `@` and a name for one of your saved snippets: its full text drops into the box, ready to edit. Esc closes the list. Your snippets: **Snippets** in Settings.

## How do I save an idea for later?

Press **Ideas** on the rail (the light bulb). Type, press **Dictate**, record a **Voice note** or add a **Photo**, then **Save idea**. On Telegram, send the bot a voice note or a photo on its own, a message that starts with 💡 or the word רעיון, or `/idea` and the text; a plain message still opens the seat picker, which now also has **Save as idea**. A reply to a notification still goes to its chat. Each idea is transcribed (on this server) and prepared: a title, the project, the kind of work, a goal, what the AI needs to know, open questions and a first message. When you have time, open it and press **Start chat**: a new chat opens in that project with the message in the box, not sent. **Make task** puts it on My tasks instead. Ready ideas you leave alone come back once a day on Telegram (18:00 by default, never at night). Processor seat, reminder time and Telegram capture: **Ideas** in Settings.

## How do I click something on the server's screen?

Press **Desktop** on the rail (the monitor). The server's desktop (the Remote Desktop session) opens, scaled to fit. Tap = click, long press = right click, two fingers = scroll, pinch = zoom. **Keyboard** opens the phone's keyboard; **Ctrl** and **Alt** stay pressed for the next key, **Esc** and **Tab** are one tap. **Paste text to the server** puts text on its clipboard (paste there with Ctrl+V). **View only** watches without touching. No password: the console's own login is the gate. Linux servers only: it needs xrdp, x11vnc and the novnc package, and someone logged in over Remote Desktop (without them the button is hidden); after 30 minutes without input it disconnects.

## Something is waiting for me. What now?

A row marked **needs approval** has a tool waiting: open the chat and press **Allow once** or **Deny** on its card. A row marked **waiting for your answer** ended with a question. Write your reply, or tap one of the suggested replies above the box (they only fill it in, nothing is sent). If no answer is needed, press ✕ on the row or **Close question** in its ⋯ menu.

## How do I keep a chat, or put one away?

Open the ⋯ menu on a row. **Keep (no auto-archive)** adds a ★: the chat is never archived on its own. **Archive** takes it out of the list. **Show archived (…)** at the bottom of a seat brings archived chats back into view, and search finds them too. **Move to project…** lists a chat under a different project without changing its folder.

## Why did a chat move to the archive by itself?

Two settings do this, both under **Settings** › **Usage & limits**. **Auto-archive finished chats after** (30 minutes by default) archives a chat that finished its work, needs nothing from you and has been quiet that long. **Auto-archive after** (3 days by default) archives a chat nobody touched in that time. Starred chats are never moved, and 0 turns either setting off. If you unarchive a chat, the finished-chat rule leaves it alone until you write in it again.

## How do I find an old chat?

Type in the search box at the top of the sidebar. It searches every conversation, archived ones included, and stays at the top while the list scrolls. Press × in the box or Esc to clear it and get the normal list back.

## What is the Projects page for?

**Open projects** in the sidebar opens it. Every folder with something going on gets one row: who is working, what waits on you, the last change, and each run as one line. **Open project** opens the folder's page. Quiet folders are under **All folders (…)**, where **New chat here** starts a chat that works in that folder.

## How do I run a bigger job across seats?

Under **Start a run**, give the run a name, a folder and a brief, then press **Plan it**. The owner seat splits the brief into tasks and shows you the plan. **Approve plan and dispatch** starts each task on the seat fixed for its kind of work. A seat at its limit makes its tasks wait for the reset. They are never moved to another seat.

## What does a project page show?

**Needs you** lists the chats waiting on you: an approval, an answer, a usage limit or an error. When nothing waits it says **All clear**. **Working now** shows the most recent active chat in large type, the others below it. **Runs here** draws each run as a bar of tasks, and **Show all tasks** opens the list. **What’s happening** shows the top of the folder's HANDOFF.md and the latest commits. The chats come in two branches: **Opened here** lists the ones started in this folder, **Related** the chats opened elsewhere that edited or read its files. **Pin to this project** files such a chat under this project, **Not related** hides it here.

## How do I move between the chats of one project?

A chat you open from a project page gets a project bar on top: **Back to project**, **New chat here**, **Move to project…** and the project's other live chats, one click each. A chat opened from the sidebar shows the normal view, without the bar.

## Which settings are worth knowing?

**Settings** sits at the top of the sidebar. **Start** › **Language** sets the language of the page and of the Telegram bot. **Usage & limits** holds the two auto-archive settings. **Projects** › **Fresh conversation at** (40 % by default): when a run's task fills that much of its context window and stops unfinished, it carries on in a new short chat. Press **Save** after a change.

## How do I hear about a new version?

Turn on **Settings** › **Start** › **Tell me when a new version is out**. It is off by default. Once a day the console asks GitHub whether the public repository is ahead of your checkout, and sends nothing about you. If it is, a small notice names the newest change, links to **What's new** and shows the command to update: run `git pull` in the console folder, then restart the console. Close the notice and it stays away until the next release.
