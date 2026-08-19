'use strict';

// Last-activity ordering for the admin chat list. Core only keeps such
// ordering per user (`uid:<uid>:chat:rooms`, bumped on every message) — the
// global `chat:rooms` set is scored once at room creation and never again,
// so listing from it sorts by creation date and buries active rooms. This
// module maintains a plugin-owned set scored like the per-user one.

const Messaging = nodebb.require('./src/messaging');
const db = nodebb.require('./src/database');

const ACTIVITY_SET = 'admin-chats:rooms:lastpost';
const BACKFILL_BATCH_SIZE = 100;

function overrideForActivityTracking() {
    if (typeof Messaging.addRoomToUsers === 'function' && !Messaging.addRoomToUsers._adminChatsActivityWrapped) {
        const originalAddRoomToUsers = Messaging.addRoomToUsers;

        // addRoomToUsers is core's own "bump this private room" signal — it runs
        // on private room creation (src/messaging/rooms.js) and on every message
        // (src/messaging/create.js), always with the activity timestamp.
        const wrappedAddRoomToUsers = async function (roomId, uids, timestamp) {
            await db.sortedSetAdd(ACTIVITY_SET, timestamp, roomId);
            return await originalAddRoomToUsers.call(this, roomId, uids, timestamp);
        };

        wrappedAddRoomToUsers._adminChatsActivityWrapped = true;
        Messaging.addRoomToUsers = wrappedAddRoomToUsers;
    }

    if (typeof Messaging.deleteRooms === 'function' && !Messaging.deleteRooms._adminChatsActivityWrapped) {
        const originalDeleteRooms = Messaging.deleteRooms;

        const wrappedDeleteRooms = async function (roomIds) {
            const result = await originalDeleteRooms.call(this, roomIds);
            await db.sortedSetRemove(ACTIVITY_SET, Array.isArray(roomIds) ? roomIds : [roomIds]);
            return result;
        };

        wrappedDeleteRooms._adminChatsActivityWrapped = true;
        Messaging.deleteRooms = wrappedDeleteRooms;
    }
}

// Reconcile on startup: private rooms not yet in the activity set (created
// before this feature existed, or while the plugin was disabled) get scored
// by their last message's timestamp, falling back to room creation time.
async function backfillActivitySet() {
    const allRooms = await db.getSortedSetRangeWithScores('chat:rooms', 0, -1);
    if (!allRooms.length) {
        return;
    }

    const roomIds = allRooms.map(item => item.value);
    const [inActivitySet, isPublic] = await Promise.all([
        db.isSortedSetMembers(ACTIVITY_SET, roomIds),
        db.isSortedSetMembers('chat:rooms:public', roomIds),
    ]);

    const missing = allRooms.filter((item, index) => !inActivitySet[index] && !isPublic[index]);

    for (let offset = 0; offset < missing.length; offset += BACKFILL_BATCH_SIZE) {
        const batch = missing.slice(offset, offset + BACKFILL_BATCH_SIZE);
        const lastMessages = await Promise.all(
            batch.map(item => db.getSortedSetRevRangeWithScores(`chat:room:${item.value}:mids`, 0, 0))
        );
        await db.sortedSetAddBulk(batch.map((item, index) => [
            ACTIVITY_SET,
            (lastMessages[index][0] && lastMessages[index][0].score) || item.score,
            item.value,
        ]));
    }
}

// Entries whose room no longer resolves (deleted outside deleteRooms, or
// before this module wrapped it) are pruned lazily by the room list.
async function pruneActivityEntries(roomIds) {
    if (roomIds.length) {
        await db.sortedSetRemove(ACTIVITY_SET, roomIds);
    }
}

module.exports = {
    ACTIVITY_SET,
    overrideForActivityTracking,
    backfillActivitySet,
    pruneActivityEntries,
};
