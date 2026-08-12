'use strict';

// Monkey-patches on core modules. NodeBB 4.14 has no hook for "room is
// locked" style reply/edit/delete restriction or for intercepting chat
// room-switch routing, so wrapping these functions is still the only way to
// enforce admin-chat locks and custom admin routing.

const User = require.main.require('./src/user');
const Messaging = require.main.require('./src/messaging');
const ChatsAPI = require.main.require('./src/api/chats');
const db = require.main.require('./src/database');
const {
    canManageAdminChats, canAccessAdminChats, guessRoomIdUidFromArgs, isUserMemberOfRoom,
    ADMIN_CHATS_PRIVILEGE, ADMIN_CHATS_MANAGE_PRIVILEGE,
} = require('./access');
const { isRoomLocked } = require('./lock');
const { editHistoryKey } = require('./history');
const privileges = require.main.require('./src/privileges');

// NodeBB translates `[[namespace:key]]` error messages itself (both in
// app.alertError on the client and anywhere else the message surfaces) —
// no need to resolve the string server-side for the acting user's language.
const LOCKED_ACTION_ERROR = '[[admin-chats:errors.lockedAction]]';

async function getMessageRoomId(messageId) {
    const roomId = await db.getObjectField(`message:${messageId}`, 'roomId');
    return parseInt(roomId, 10) || 0;
}

function overrideCoreChatRedirect(controllers, renderAdminChatsPage) {
    const chatsController = controllers && controllers.accounts && controllers.accounts.chats;
    if (!chatsController || typeof chatsController.redirectToChat !== 'function' || chatsController.redirectToChat._adminChatsWrapped) {
        return;
    }

    const originalRedirectToChat = chatsController.redirectToChat;
    const wrappedRedirectToChat = async function (req, res, next) {
        if (req && req.uid && await canAccessAdminChats(req.uid)) {
            return await renderAdminChatsPage(req, res, next);
        }

        return await originalRedirectToChat.call(this, req, res, next);
    };

    wrappedRedirectToChat._adminChatsWrapped = true;
    chatsController.redirectToChat = wrappedRedirectToChat;
}

function overrideChatsApi() {
    if (!ChatsAPI || typeof ChatsAPI.kick !== 'function' || ChatsAPI.kick._adminChatLockWrapped) {
        return;
    }

    const originalKick = ChatsAPI.kick;
    const wrappedKick = async function (caller, data) {
        const isSelfKick = caller && data && data.roomId && Array.isArray(data.uids) &&
            data.uids.length === 1 && parseInt(data.uids[0], 10) === parseInt(caller.uid, 10);

        if (isSelfKick && !await User.isAdministrator(caller.uid) && !await canManageAdminChats(caller.uid) &&
            await isRoomLocked(data.roomId)) {
            throw new Error(LOCKED_ACTION_ERROR);
        }

        return await originalKick.call(this, caller, data);
    };

    wrappedKick._adminChatLockWrapped = true;
    ChatsAPI.kick = wrappedKick;
}

function overrideMessagingFunctions() {
    const originalCanEdit = Messaging.canEdit;
    const originalCanDelete = Messaging.canDelete;
    const originalCanViewMessage = Messaging.canViewMessage;
    const originalCanReply = Messaging.canReply;

    if (typeof Messaging.editMessage === 'function' && !Messaging.editMessage._adminChatsHistoryWrapped) {
        const originalEditMessage = Messaging.editMessage;

        const wrappedEditMessage = async function (uid, mid, roomId, content) {
            let previous = null;
            try {
                const [oldContent, fields] = await Promise.all([
                    Messaging.getMessageField(mid, 'content'),
                    Messaging.getMessageFields(mid, ['fromuid', 'timestamp', 'edited']),
                ]);
                // Only snapshot when the content actually changes, mirroring core's
                // no-op short-circuit so history stays in step with real edits.
                if (typeof oldContent === 'string' && oldContent !== content) {
                    previous = {
                        content: oldContent,
                        fromuid: parseInt(fields && fields.fromuid, 10) || 0,
                        editedByUid: parseInt(uid, 10) || 0,
                        replacedAt: Date.now(),
                        previousEdited: parseInt(fields && fields.edited, 10) ||
                            parseInt(fields && fields.timestamp, 10) || 0,
                    };
                }
            } catch (err) {
                previous = null;
            }

            const result = await originalEditMessage.call(this, uid, mid, roomId, content);

            if (previous) {
                try {
                    await db.listAppend(editHistoryKey(mid), JSON.stringify(previous));
                } catch (err) {
                    // History is best-effort; never break an edit because of it.
                }
            }

            return result;
        };

        wrappedEditMessage._adminChatsHistoryWrapped = true;
        Messaging.editMessage = wrappedEditMessage;
    }

    Messaging.canEdit = async function (messageId, uid) {
        if (await User.isAdministrator(uid) || await canManageAdminChats(uid)) {
            return true;
        }

        const roomId = await getMessageRoomId(messageId);
        if (roomId && await isRoomLocked(roomId)) {
            throw new Error(LOCKED_ACTION_ERROR);
        }

        return await originalCanEdit(messageId, uid);
    };

    Messaging.canDelete = async function (messageId, uid) {
        if (await User.isAdministrator(uid) || await canManageAdminChats(uid)) {
            return true;
        }

        const roomId = await getMessageRoomId(messageId);
        if (roomId && await isRoomLocked(roomId)) {
            throw new Error(LOCKED_ACTION_ERROR);
        }

        return await originalCanDelete(messageId, uid);
    };

    Messaging.canViewMessage = async function (mids, roomId, uid) {
        if (await canAccessAdminChats(uid)) {
            return Array.isArray(mids) ? mids.map(() => true) : true;
        }
        return await originalCanViewMessage(mids, roomId, uid);
    };

    if (typeof originalCanReply === 'function') {
        Messaging.canReply = async function (...args) {
            const guessed = guessRoomIdUidFromArgs(args);
            const [isAdmin, canView, canManage] = await Promise.all([
                User.isAdministrator(guessed.uid),
                privileges.global.can(ADMIN_CHATS_PRIVILEGE, guessed.uid),
                privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, guessed.uid),
            ]);
            const isManager = isAdmin || canManage;
            const hasAccess = isAdmin || canView || canManage;

            if (isManager) {
                return true;
            }
            if (guessed.roomId && hasAccess) {
                const isMember = await isUserMemberOfRoom(guessed.uid, guessed.roomId);
                if (!isMember) {
                    return false;
                }
            }
            if (guessed.roomId && await isRoomLocked(guessed.roomId)) {
                return false;
            }
            return await originalCanReply.apply(this, args);
        };
    }
}

module.exports = {
    getMessageRoomId,
    overrideCoreChatRedirect,
    overrideChatsApi,
    overrideMessagingFunctions,
};
