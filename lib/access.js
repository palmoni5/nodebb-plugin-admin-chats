'use strict';

const User = nodebb.require('./src/user');
const privileges = nodebb.require('./src/privileges');
const db = nodebb.require('./src/database');

const ADMIN_CHATS_PRIVILEGE = 'admin-chats:view';
const ADMIN_CHATS_MANAGE_PRIVILEGE = 'admin-chats:manage';

async function canAccessAdminChats(uid) {
    if (!uid) {
        return false;
    }

    const [isAdmin, canView, canManage] = await Promise.all([
        User.isAdministrator(uid),
        privileges.global.can(ADMIN_CHATS_PRIVILEGE, uid),
        privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, uid),
    ]);

    return isAdmin || canView || canManage;
}

async function canManageAdminChats(uid) {
    if (!uid) {
        return false;
    }

    const [isAdmin, canManage] = await Promise.all([
        User.isAdministrator(uid),
        privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, uid),
    ]);

    return isAdmin || canManage;
}

async function isUserMemberOfRoom(uid, roomId) {
    if (!uid || !roomId) {
        return false;
    }

    return await db.isSortedSetMember(`chat:room:${roomId}:uids`, uid);
}

function getCallerUid(payload) {
    return payload && (
        payload.uid ||
        payload.callerUid ||
        (payload.data && payload.data.uid) ||
        (payload.message && payload.message.uid)
    );
}

function getRoomId(payload) {
    return payload && (
        payload.roomId ||
        (payload.data && payload.data.roomId) ||
        (payload.message && payload.message.roomId)
    );
}

function guessRoomIdUidFromArgs(args) {
    if (!Array.isArray(args) || !args.length) {
        return { roomId: null, uid: null };
    }

    if (args.length === 1 && args[0] && typeof args[0] === 'object') {
        return {
            roomId: getRoomId(args[0]),
            uid: getCallerUid(args[0]),
        };
    }

    return {
        roomId: args[0],
        uid: args[1],
    };
}

module.exports = {
    ADMIN_CHATS_PRIVILEGE,
    ADMIN_CHATS_MANAGE_PRIVILEGE,
    canAccessAdminChats,
    canManageAdminChats,
    isUserMemberOfRoom,
    getCallerUid,
    getRoomId,
    guessRoomIdUidFromArgs,
};
