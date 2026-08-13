'use strict';

const User = nodebb.require('./src/user');
const Messaging = nodebb.require('./src/messaging');
const db = nodebb.require('./src/database');
const privileges = nodebb.require('./src/privileges');

const {
    ADMIN_CHATS_PRIVILEGE, ADMIN_CHATS_MANAGE_PRIVILEGE,
    canAccessAdminChats, canManageAdminChats, isUserMemberOfRoom, getCallerUid, getRoomId,
} = require('./access');
const {
    isRoomLocked, getRoomLockData, canNonAdminModifyLockedRoom,
    ensureFirstVisibleMessageHeader, buildRoomMessagesWithLockNotice, markMessagesLocked,
} = require('./lock');

const LOCKED_ACTION_ERROR = '[[admin-chats:errors.lockedAction]]';

const hooks = {};

hooks.registerPrivileges = async function (data) {
    if (!data || !data.privileges || typeof data.privileges.set !== 'function') {
        return data;
    }

    data.privileges.set(ADMIN_CHATS_PRIVILEGE, {
        label: '[[admin-chats:admin-chats-view]]',
        type: 'moderation',
    });

    data.privileges.set(ADMIN_CHATS_MANAGE_PRIVILEGE, {
        label: '[[admin-chats:admin-chats-manage]]',
        type: 'moderation',
    });

    return data;
};

hooks.filterNotificationCreate = async function (data) {
    if (!data || !data.data) {
        return data;
    }

    const notification = data.data;
    const chatMatch = notification.path && notification.path.match(/^\/chats\/(\d+)(?:\/(\d+))?$/);
    if (chatMatch && notification.uid) {
        const roomId = chatMatch[1];
        const index = chatMatch[2];
        const userSlug = await User.getUserField(notification.uid, 'userslug');
        if (userSlug) {
            notification.path = `/user/${userSlug}/chats/${roomId}${index ? `/${index}` : ''}`;
        }
    }

    return data;
};

hooks.filterUserNotificationsGetNotifications = async function (data) {
    if (!data || !data.uid || !Array.isArray(data.notifications) || !data.notifications.length) {
        return data;
    }

    const userSlug = await User.getUserField(data.uid, 'userslug');
    if (!userSlug) {
        return data;
    }

    const userPathRegex = /\/user\/[^/]+\/chats\//;
    const chatPathRegex = /\/chats\/(\d+)(?:\/(\d+))?(?=$|[/?#])/;

    data.notifications.forEach((notification) => {
        if (!notification || !notification.path || userPathRegex.test(notification.path)) {
            return;
        }
        const match = notification.path.match(chatPathRegex);
        if (!match) {
            return;
        }
        const replacement = `/user/${userSlug}/chats/${match[1]}${match[2] ? `/${match[2]}` : ''}`;
        notification.path = notification.path.replace(chatPathRegex, replacement);
    });

    return data;
};

// data.uid here is the profile OWNER being viewed, not the viewer — the
// viewer is data.callerUID (src/controllers/accounts/helpers.js's
// getProfileMenu). Core builds each link's url itself from `route`
// (relative to /user/<profile-owner-slug>/), so there's no need to resolve
// the slug or build the path here.
hooks.addProfileLink = async function (data) {
    const viewerUid = data && data.callerUID;
    if (!viewerUid || !await canAccessAdminChats(viewerUid)) {
        return data;
    }

    data.links.push({
        id: 'admin-view-chats',
        route: 'chats',
        icon: 'fa-comments',
        name: '[[admin-chats:profile.viewChats]]',
        visibility: {
            self: true, other: true, moderator: true, globalMod: true, admin: true,
        },
    });

    return data;
};

hooks.isRoomOwner = async function (payload) {
    const [isAdmin, canManage] = await Promise.all([
        User.isAdministrator(payload.uid),
        canManageAdminChats(payload.uid),
    ]);
    if (isAdmin || canManage) {
        payload.isOwner = true;
    }
    return payload;
};

hooks.isUserInRoom = async function (payload) {
    const uid = getCallerUid(payload);
    if (await canAccessAdminChats(uid)) {
        payload.inRoom = true;
    }
    return payload;
};

hooks.canReply = async function (payload) {
    const uid = getCallerUid(payload);
    const roomId = getRoomId(payload);

    const [isAdmin, canView, canManage] = await Promise.all([
        User.isAdministrator(uid),
        privileges.global.can(ADMIN_CHATS_PRIVILEGE, uid),
        privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, uid),
    ]);
    const isManager = isAdmin || canManage;
    const hasAccess = isAdmin || canView || canManage;

    if (isManager) {
        payload.canReply = true;
        return payload;
    }

    if (roomId && hasAccess && !await isUserMemberOfRoom(uid, roomId)) {
        payload.canReply = false;
        return payload;
    }

    if (roomId && await isRoomLocked(roomId)) {
        payload.canReply = false;
    }

    return payload;
};

hooks.filterMessagingSend = async function (payload) {
    const uid = getCallerUid(payload);
    const roomId = getRoomId(payload);

    if (!uid || !roomId) {
        return payload;
    }

    if (await User.isAdministrator(uid) || await canManageAdminChats(uid)) {
        return payload;
    }

    if (await canAccessAdminChats(uid) && !await isUserMemberOfRoom(uid, roomId)) {
        throw new Error('[[error:no-privileges]]');
    }

    if (await isRoomLocked(roomId)) {
        throw new Error(LOCKED_ACTION_ERROR);
    }

    return payload;
};

async function guardRoomModification(payload) {
    if (await canManageAdminChats(payload.uid)) {
        return payload;
    }
    if (await canNonAdminModifyLockedRoom(payload.uid, payload.roomId)) {
        throw new Error(LOCKED_ACTION_ERROR);
    }
    return payload;
}

hooks.filterAddUsersToRoom = guardRoomModification;
hooks.filterRemoveUsersFromRoom = guardRoomModification;
hooks.filterRenameRoom = guardRoomModification;

hooks.canGetMessages = async function (payload) {
    if (await canAccessAdminChats(payload.callerUid)) {
        payload.canGet = true;
    }
    return payload;
};

hooks.canGetRecentChats = async function (payload) {
    if (await canAccessAdminChats(payload.callerUid)) {
        payload.canGet = true;
    }
    return payload;
};

hooks.canGetPublicChats = async function (payload) {
    if (await canAccessAdminChats(payload.callerUid)) {
        payload.canGet = true;
    }
    return payload;
};

hooks.onLoadRoom = async function (payload) {
    const { uid, room } = payload;
    if (!room) {
        return payload;
    }

    const [isAdmin, canView, canManage] = await Promise.all([
        User.isAdministrator(uid),
        privileges.global.can(ADMIN_CHATS_PRIVILEGE, uid),
        privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, uid),
    ]);
    const isManager = isAdmin || canManage;
    const hasAccess = isAdmin || canView || canManage;

    const lockData = await getRoomLockData(room.roomId);
    const isLockedForUser = lockData.isLocked && !isManager;

    room.adminChatLock = lockData;
    room.adminChatLockedForViewer = isLockedForUser;
    room.messages = markMessagesLocked(
        ensureFirstVisibleMessageHeader(buildRoomMessagesWithLockNotice(room.messages, lockData)),
        isLockedForUser
    );
    room.canReply = room.canReply && !isLockedForUser;
    room.showUserInput = room.showUserInput && !isLockedForUser;

    if (!hasAccess) {
        return payload;
    }

    const isOfficialMember = await isUserMemberOfRoom(uid, room.roomId);

    if (!isOfficialMember) {
        await db.sortedSetRemove(`chat:room:${room.roomId}:uids:online`, uid);

        if (Array.isArray(room.users)) {
            room.users = room.users.filter(user => user && parseInt(user.uid, 10) !== parseInt(uid, 10));
        }
        if (room.userCount > 0) {
            room.userCount -= 1;
        }
        room.groupChat = room.userCount > 2;

        const allMids = await db.getSortedSetRevRange(`chat:room:${room.roomId}:mids`, 0, 49);

        if (allMids.length > 0) {
            const messages = await Messaging.getMessagesData(allMids, uid, room.roomId, false);
            const messageCount = parseInt(await db.getObjectField(`chat:room:${room.roomId}`, 'messageCount'), 10) || 0;

            messages.forEach((msg, index) => {
                msg.index = messageCount - index - 1;
            });

            room.messages = markMessagesLocked(
                ensureFirstVisibleMessageHeader(buildRoomMessagesWithLockNotice(messages.reverse(), lockData)),
                isLockedForUser
            );

            room.messages.forEach((msg, index) => {
                if (index === 0) {
                    msg.newSet = true;
                } else {
                    const prevMsg = room.messages[index - 1];
                    const prevTime = parseInt(prevMsg && prevMsg.timestamp, 10) || 0;
                    const currentTime = parseInt(msg && msg.timestamp, 10) || 0;

                    msg.newSet = !!(
                        currentTime > prevTime + Messaging.newMessageCutoff ||
                        parseInt(msg.fromuid, 10) !== parseInt(prevMsg.fromuid, 10) ||
                        prevMsg.system ||
                        msg.toMid
                    );
                }
            });

            room.messages = ensureFirstVisibleMessageHeader(room.messages);
        }
    }

    if (!isManager && !isOfficialMember) {
        room.canReply = false;
        room.showUserInput = false;
    }

    room.isAdmin = isManager;
    room.isAdminOrGlobalMod = isManager;
    payload.isAdminOrGlobalMod = isManager;
    if (isManager) {
        room.isOwner = true;
    }

    return payload;
};

module.exports = hooks;
