'use strict';

const db = require.main.require('./src/database');
const User = require.main.require('./src/user');
const { canManageAdminChats } = require('./access');

// Marker type on the synthetic system message this plugin injects when a
// room is locked — mirrors how core tags its own system messages
// ('user-join', 'user-leave', ...) instead of sniffing message content.
const LOCK_MESSAGE_TYPE = 'admin-chat-lock';

async function roomExists(roomId) {
    const roomData = await db.getObject(`chat:room:${roomId}`);
    return !!roomData;
}

async function lockRoom(roomId, actingUid) {
    await db.setObject(`chat:room:${roomId}:adminLock`, {
        isLocked: 1,
        lockedBy: actingUid,
        lockedAt: Date.now(),
    });

    return await getRoomLockData(roomId);
}

async function unlockRoom(roomId, actingUid) {
    await db.setObject(`chat:room:${roomId}:adminLock`, {
        isLocked: 0,
        lockedBy: actingUid,
        lockedAt: 0,
    });

    return await getRoomLockData(roomId);
}

async function isRoomLocked(roomId) {
    const field = await db.getObjectField(`chat:room:${roomId}:adminLock`, 'isLocked');
    return field === '1' || field === 1 || field === true;
}

async function getRoomLockData(roomId) {
    const data = await db.getObject(`chat:room:${roomId}:adminLock`) || {};
    return {
        isLocked: data.isLocked === '1' || data.isLocked === 1 || data.isLocked === true,
        lockedBy: parseInt(data.lockedBy, 10) || 0,
        lockedAt: parseInt(data.lockedAt, 10) || 0,
    };
}

async function canNonAdminModifyLockedRoom(uid, roomId) {
    if (!uid || !roomId) {
        return false;
    }

    if (await User.isAdministrator(uid)) {
        return false;
    }

    if (await canManageAdminChats(uid)) {
        return false;
    }

    return await isRoomLocked(roomId);
}

function isAdminLockMessage(msg) {
    return !!(msg && msg.type === LOCK_MESSAGE_TYPE);
}

function stripAdminLockMessages(messages) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    return list.filter(msg => !isAdminLockMessage(msg));
}

function ensureFirstVisibleMessageHeader(messages) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    const firstUserMessageIndex = list.findIndex(msg => msg && !msg.system);

    if (firstUserMessageIndex !== -1) {
        list[firstUserMessageIndex].newSet = true;
    }

    return list;
}

// Marks every message rendered while the room is locked with `adminChatLocked`
// so partials/chats/message.tpl can hide edit/delete/restore for non-managers
// without a client-side visibility pass.
function markMessagesLocked(messages, isLockedForViewer) {
    if (!isLockedForViewer) {
        return messages;
    }
    (messages || []).forEach((msg) => {
        if (msg && !msg.system) {
            msg.adminChatLocked = true;
        }
    });
    return messages;
}

function buildRoomMessagesWithLockNotice(messages, lockData) {
    const cleanedMessages = stripAdminLockMessages(messages);
    if (!lockData || !lockData.isLocked || !lockData.lockedAt) {
        return cleanedMessages;
    }

    cleanedMessages.push({
        // Raw translation token, resolved per-viewer at render time by
        // partials/chats/system-message.tpl's {{tx(messages.content)}} —
        // the same pattern core uses for its own system messages
        // (src/messaging/create.js: Messaging.addSystemMessage).
        content: '[[admin-chats:lock.banner]]',
        type: LOCK_MESSAGE_TYPE,
        fromuid: lockData.lockedBy,
        uid: lockData.lockedBy,
        timestamp: lockData.lockedAt,
        datetime: lockData.lockedAt,
        system: true,
        newSet: true,
    });

    cleanedMessages.sort((left, right) => {
        const leftTime = parseInt(left && (left.timestamp || left.datetime), 10) || 0;
        const rightTime = parseInt(right && (right.timestamp || right.datetime), 10) || 0;
        return leftTime - rightTime;
    });

    return cleanedMessages;
}

module.exports = {
    LOCK_MESSAGE_TYPE,
    roomExists,
    lockRoom,
    unlockRoom,
    isRoomLocked,
    getRoomLockData,
    canNonAdminModifyLockedRoom,
    isAdminLockMessage,
    stripAdminLockMessages,
    ensureFirstVisibleMessageHeader,
    markMessagesLocked,
    buildRoomMessagesWithLockNotice,
};
