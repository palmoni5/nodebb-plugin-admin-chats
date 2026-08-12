# Super Admin Chat Control for NodeBB

A professional administration plugin for NodeBB that allows administrators to monitor, manage, and interact with any chat room on the forum, regardless of membership.

## Main Features

* **Global Chat Access**: Administrators and users with chat view permission can view any private or group conversation.
* **Management Privileges**: Administrators and users with chat management permission can edit or delete any message in any room.
* **Admin Room Locking**: Administrators can lock any chat room so only admins can continue replying.
* **Profile Integration**: Adds a "View Chats" button to the user profile menu for administrators to quickly audit a user's interactions.
* **Non-Intrusive Monitoring**: Admins can load and view room history without being added as permanent members, maintaining a clean member list.
* **UI Enhancements**: Replaces generic "no chats" messages with helpful instructions for admins and supports both English and Hebrew interfaces.

## Technical Overview

### Plugin Information
* **Name**: Super Admin Chat Control
* **ID**: `nodebb-plugin-admin-chats`
* **Compatibility**: NodeBB version `^4.0.0` (tested through 4.14)

### Code Layout
* `library.js` — thin entry point; wires together the modules below.
* `lib/access.js`, `lib/lock.js`, `lib/history.js`, `lib/hooks.js`, `lib/routes.js`, `lib/overrides.js` — server-side logic, split by concern.
* `templates/partials/chats/*.tpl` — overrides of core's chat partials (controls menu, message actions, empty state, recent-room list) so the lock UI, participants line and admin menu item render server-side instead of being built with client-side DOM manipulation.
* `static/lib/switch-chat.js`, `static/lib/lock-toggle.js`, `static/lib/live-updates.js` — client-side: admin room routing, the lock/unlock click handler, and live updates pushed over a targeted socket event when a room's lock state changes.

### Permissions
The plugin exposes two global permissions in the ACP:

* `admin-chats:view`: View any chat room and load history (read-only access).
* `admin-chats:manage`: Manage any chat room (edit/delete messages, lock/unlock rooms, and other moderator-level actions).

### Chat Route Behavior (`/chats`)
NodeBB exposes a core route at `/chats` (and `/chats/:roomId/:index?`) that redirects logged-in users to their personal chat page under `/user/:userslug/chats/...`.
This plugin also rewrites chat notification links to use `/user/:userslug/chats/...`, ensuring admins land on the correct user-scoped chat view when opening notifications.

### Implemented Hooks
The plugin utilizes several filters to elevate administrator permissions:

| Hook | Method | Functionality |
| :--- | :--- | :--- |
| `filter:messaging.isRoomOwner` | `isRoomOwner` | Treats admins as owners for permission checks. |
| `filter:messaging.canReply` | `canReply` | Allows admins to send messages in any room and blocks regular users in admin-locked rooms. |
| `filter:messaging.canGetMessages` | `canGetMessages` | Allows admins to fetch chat history. |
| `filter:messaging.loadRoom` | `onLoadRoom` | Manages room loading logic for non-member admins and injects lock state. |
| `filter:user.accountMenu` | `addProfileLink` | Injects the admin link into the profile menu. |

### Function Overrides
The plugin overrides core messaging functions to ensure full administrative control:
* **Edit/Delete**: `Messaging.canEdit` and `Messaging.canDelete` are bypassed for administrators.
* **Visibility**: `Messaging.canViewMessage` is modified to always return `true` for admins.
* **Room Locking**: `Messaging.canReply` is wrapped so non-admins cannot post in rooms locked by an admin.

## Installation

### Option 1: Via Admin Control Panel (Recommended)
1. Navigate to the NodeBB Admin Control Panel (ACP).
2. Go to **Extend** → **Plugins**.
3. Search for "nodebb-plugin-admin-chats".
4. Click **Install**.
5. Activate the plugin and restart NodeBB.

### Option 2: Via Terminal
1. Install the plugin via terminal:
   ```bash
   npm install nodebb-plugin-admin-chats
   ```
2. Activate the plugin in the NodeBB Admin Control Panel (ACP).
3. Restart NodeBB.

## Client-Side Support
Lock state, the admin menu item, the empty-state copy and the participants line are all rendered server-side via the template overrides in `templates/partials/chats/`, using NodeBB's own translation system (`[[admin-chats:...]]` / `tx()`) — no client-side DOM injection or language sniffing. The `static/lib/` scripts only handle:
* Routing chat-room switches through the admin API when viewing the all-chats admin page (`static/lib/switch-chat.js`).
* Wiring the lock/unlock menu item's click handler (`static/lib/lock-toggle.js`).
* Pushing live updates to anyone with an affected room open, via a `event:admin-chats.roomLockChanged` socket broadcast, instead of polling (`static/lib/live-updates.js`).

---
*Developed by [palmoni5](https://github.com/palmoni5/nodebb-plugin-admin-chats).* 