'use strict';

const User = require.main.require('./src/user');
const Messaging = require.main.require('./src/messaging');
const ChatsAPI = require.main.require('./src/api/chats');
const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const privileges = require.main.require('./src/privileges');
const helpers = require.main.require('./src/controllers/helpers');

const plugin = {};
const LOCK_PREFIX = '[admin-chat-lock]';
const LOCKED_MESSAGE_TEXT = '🔒 חדר זה ננעל ע"י המנהלים.';
const ADMIN_CHATS_PRIVILEGE = 'admin-chats:view';
const ADMIN_CHATS_MANAGE_PRIVILEGE = 'admin-chats:manage';

async function getLockedActionMessage(uid) {
    try {
        const userData = await User.getUserData(uid);
        let userLang = userData && userData.settings && userData.userLang;
        
        // If user doesn't have specific language setting, use forum default
        if (!userLang) {
            const meta = require.main.require('./src/meta');
            userLang = meta.config.defaultLang || 'en-GB';
        }
        
        if (userLang === 'he' || userLang === 'he-IL') {
            return 'לא ניתן לבצע פעולה זו בחדר נעול';
        } else {
            return 'This action cannot be performed in a locked room.';
        }
    } catch (err) {
        // Default to English if we can't determine language
        return 'This action cannot be performed in a locked room.';
    }
}
const ADMIN_CHAT_PAGE_SIZE = 30;
const ADMIN_CHAT_SCAN_SIZE = 100;

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
plugin.init = async function (params) {
    registerRoutes(params.app, params.router, params.middleware);
    overrideMessagingFunctions();
    overrideChatsApi();
    overrideCoreChatRedirect(params.controllers);
};
plugin.registerPrivileges = async function (data) {
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

plugin.filterNotificationCreate = async function (data) {
    if (!data || !data.data) {
        return data;
    }

    const notification = data.data;
    
    // Check if this is a chat notification with path like /chats/123
    if (notification.path && notification.path.match(/^\/chats\/\d+/)) {
        const chatMatch = notification.path.match(/^\/chats\/(\d+)(?:\/(\d+))?$/);
        if (chatMatch && notification && notification.uid) {
            const roomId = chatMatch[1];
            const index = chatMatch[2];
            
            // Get the user's slug to redirect to their personal chat page
            const userSlug = await User.getUserField(notification.uid, 'userslug');
            if (userSlug) {
                notification.path = `/user/${userSlug}/chats/${roomId}${index ? `/${index}` : ''}`;
            }
        }
    }

    return data;
};

plugin.filterUserNotificationsGetNotifications = async function (data) {
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
        if (!notification || !notification.path) {
            return;
        }
        if (userPathRegex.test(notification.path)) {
            return;
        }
        const match = notification.path.match(chatPathRegex);
        if (!match) {
            return;
        }
        const roomId = match[1];
        const index = match[2];
        const replacement = `/user/${userSlug}/chats/${roomId}${index ? `/${index}` : ''}`;
        notification.path = notification.path.replace(chatPathRegex, replacement);
    });

    return data;
};
plugin.addScripts = async function (data) {
    let isHebrew = false;
    
    const uid = data.req && data.req.uid;
    if (uid) {
        try {
            const userData = await User.getUserData(uid);
            let userLang = userData && userData.settings && userData.userLang;
            
            // If user doesn't have specific language setting, use forum default
            if (!userLang) {
                const meta = require.main.require('./src/meta');
                userLang = meta.config.defaultLang || 'en-GB';
            }
            
            isHebrew = userLang === 'he' || userLang === 'he-IL';
        } catch (err) {
            // Default to English if error
            isHebrew = false;
        }
    }
    
    // Only send the lockedAction translation from server
    const translations = {
        lockedAction: isHebrew ? 'לא ניתן לבצע פעולה זו בחדר נעול' : 'This action cannot be performed in a locked room.',
    };

    const isAdmin = uid ? await User.isAdministrator(uid) : false;
    const adminChatsManage = uid ? (isAdmin || await privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, uid)) : false;
    const adminChatsAccess = uid ? (isAdmin || adminChatsManage || await privileges.global.can(ADMIN_CHATS_PRIVILEGE, uid)) : false;

    data.scripts = data.scripts || [];
    data.scripts.push({
        src: false,
        script: `window.adminChatsTranslations = ${JSON.stringify(translations)}; window.adminChatsAccess = ${adminChatsAccess}; window.adminChatsIsAdmin = ${isAdmin}; window.adminChatsCanManage = ${adminChatsManage};`
    });

    return data;
};

plugin.addProfileLink = async function (data) {
    try {
        const uid = data && (data.uid || (data.req && data.req.uid));
        if (!uid || !await canAccessAdminChats(uid)) {
            return data;
        }

        const userSlug = data.user ? data.user.userslug : (data.userData ? data.userData.userslug : null);

        if (userSlug) {
            data.links.push({
                id: 'admin-view-chats',
                route: 'user/' + userSlug + '/chats',
                icon: 'fa-comments',
                name: '[[admin-chats:profile.viewChats]]',
                visibility: {
                    self: true,
                    other: true,
                    moderator: true,
                    globalMod: true,
                    admin: true,
                }
            });
        }
    } catch (e) {
        // Silent error handling
    }
    return data;
};

plugin.isRoomOwner = async function (payload) {
    const [isAdmin, canManage] = await Promise.all([
        User.isAdministrator(payload.uid),
        canManageAdminChats(payload.uid),
    ]);
    if (isAdmin || canManage) {
        payload.isOwner = true;
    }
    return payload;
};

plugin.isUserInRoom = async function (payload) {
    const uid = getCallerUid(payload);
    if (await canAccessAdminChats(uid)) {
        payload.inRoom = true;
    }
    return payload;
};

plugin.canReply = async function (payload) {
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

    if (roomId && hasAccess) {
        const isMember = await isUserMemberOfRoom(uid, roomId);
        if (!isMember) {
            payload.canReply = false;
            return payload;
        }
    }

    if (roomId && await isRoomLocked(roomId)) {
        payload.canReply = false;
    }

    return payload;
};

plugin.filterMessagingSend = async function (payload) {
    const uid = getCallerUid(payload);
    const roomId = getRoomId(payload);

    if (!uid || !roomId) {
        return payload;
    }

    if (await User.isAdministrator(uid)) {
        return payload;
    }

    if (await canManageAdminChats(uid)) {
        return payload;
    }

    if (await canAccessAdminChats(uid)) {
        const isMember = await isUserMemberOfRoom(uid, roomId);
        if (!isMember) {
            throw new Error('[[error:no-privileges]]');
        }
    }

    if (await isRoomLocked(roomId)) {
        const message = await getLockedActionMessage(uid);
        throw new Error(message);
    }

    return payload;
};
plugin.filterAddUsersToRoom = async function (payload) {
    if (await canManageAdminChats(payload.uid)) {
        return payload;
    }
    if (await canNonAdminModifyLockedRoom(payload.uid, payload.roomId)) {
        const message = await getLockedActionMessage(payload.uid);
        throw new Error(message);
    }
    return payload;
};

plugin.filterRemoveUsersFromRoom = async function (payload) {
    if (await canManageAdminChats(payload.uid)) {
        return payload;
    }
    if (await canNonAdminModifyLockedRoom(payload.uid, payload.roomId)) {
        const message = await getLockedActionMessage(payload.uid);
        throw new Error(message);
    }
    return payload;
};

plugin.filterRenameRoom = async function (payload) {
    if (await canManageAdminChats(payload.uid)) {
        return payload;
    }
    if (await canNonAdminModifyLockedRoom(payload.uid, payload.roomId)) {
        const message = await getLockedActionMessage(payload.uid);
        throw new Error(message);
    }
    return payload;
};

plugin.canGetMessages = async function (payload) {
    if (await canAccessAdminChats(payload.callerUid)) {
        payload.canGet = true;
    }
    return payload;
};

plugin.canGetRecentChats = async function (payload) {
    if (await canAccessAdminChats(payload.callerUid)) {
        payload.canGet = true;
    }
    return payload;
};

plugin.canGetPublicChats = async function (payload) {
    if (await canAccessAdminChats(payload.callerUid)) {
        payload.canGet = true;
    }
    return payload;
};

plugin.onLoadRoom = async function (payload) {
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
    room.messages = ensureFirstVisibleMessageHeader(buildRoomMessagesWithLockNotice(room.messages, lockData));
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
            const messageCount = await db.getObjectField(`chat:room:${room.roomId}`, 'messageCount');
            const count = parseInt(messageCount, 10) || 0;

            messages.forEach((msg, index) => {
                msg.index = count - index - 1;
            });

            room.messages = ensureFirstVisibleMessageHeader(buildRoomMessagesWithLockNotice(messages.reverse(), lockData));

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
    room.adminChatsAccess = hasAccess;
    payload.adminChatsAccess = hasAccess;
    payload.adminChatsCanManage = isManager;
    payload.adminChatsIsAdmin = isAdmin;

    return payload;
};

function overrideCoreChatRedirect(controllers) {
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
        if (caller && !await User.isAdministrator(caller.uid) && !await canManageAdminChats(caller.uid) && data && data.roomId && Array.isArray(data.uids) && data.uids.length === 1 && parseInt(data.uids[0], 10) === parseInt(caller.uid, 10) && await isRoomLocked(data.roomId)) {
            const message = await getLockedActionMessage(caller.uid);
            throw new Error(message);
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

    Messaging.canEdit = async function (messageId, uid) {
        if (await User.isAdministrator(uid)) {
            return true;
        }

        if (await canManageAdminChats(uid)) {
            return true;
        }

        const roomId = await getMessageRoomId(messageId);
        if (roomId && await isRoomLocked(roomId)) {
            const message = await getLockedActionMessage(uid);
            throw new Error(message);
        }

        return await originalCanEdit(messageId, uid);
    };

    Messaging.canDelete = async function (messageId, uid) {
        if (await User.isAdministrator(uid)) {
            return true;
        }

        if (await canManageAdminChats(uid)) {
            return true;
        }

        const roomId = await getMessageRoomId(messageId);
        if (roomId && await isRoomLocked(roomId)) {
            const message = await getLockedActionMessage(uid);
            throw new Error(message);
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

function registerRoutes(app, router, middleware) {
    if (!router) {
        return;
    }

    const routeMiddleware = [];
    if (middleware && typeof middleware.ensureLoggedIn === 'function') {
        routeMiddleware.push(middleware.ensureLoggedIn);
    }

    const pageMiddlewares = [
        middleware.autoLocale,
        middleware.applyBlacklist,
        middleware.authenticateRequest,
        middleware.redirectToHomeIfBanned,
        middleware.maintenanceMode,
        middleware.registrationComplete,
        middleware.pluginHooks,
        ...routeMiddleware,
        middleware.pageView,
    ].filter(Boolean);

    const pageController = async (req, res, next) => {
        try {
            // If user is not allowed, redirect to user-specific chat URL
            if (req.uid && !await canAccessAdminChats(req.uid)) {
                const userSlug = await User.getUserField(req.uid, 'userslug');
                if (userSlug && req.params.roomId) {
                    const redirectUrl = `${req.baseUrl || ''}/user/${userSlug}/chats/${req.params.roomId}${req.params.index ? `/${req.params.index}` : ''}`;
                    return res.redirect(redirectUrl);
                }
            }
            
            await renderAdminChatsPage(req, res, next);
        } catch (err) {
            next(err);
        }
    };

    const pageRouter = app || router;
    pageRouter.get('/chats/:roomId?/:index?', middleware.busyCheck, pageMiddlewares, middleware.buildHeader, pageController);

    router.get('/api/admin-chats', ...routeMiddleware, async (req, res) => {
        try {
            if (!await assertAdminChatsAccess(req, res)) {
                return;
            }

            const start = Math.max(0, parseInt(req.query.start, 10) || 0);
            const data = await getAdminRecentChats(req.uid, start, ADMIN_CHAT_PAGE_SIZE);
            res.json(data);
        } catch (err) {
            res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    
    router.get('/api/admin-chats/privileges', ...routeMiddleware, async (req, res) => {
        try {
            if (!await assertAdminChatsAccess(req, res)) {
                return;
            }

            const isAdmin = await User.isAdministrator(req.uid);
            const canManage = isAdmin || await privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, req.uid);
            res.json({
                adminChatsAccess: true,
                adminChatsCanManage: canManage,
                adminChatsIsAdmin: isAdmin,
            });
        } catch (err) {
            res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    router.get('/api/admin-chats/page/:roomId?/:index?', ...routeMiddleware, async (req, res) => {
        try {
            if (!await assertAdminChatsAccess(req, res)) {
                return;
            }

            const payload = await buildAdminChatsPayload(req);
            res.json(payload);
        } catch (err) {
            res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    router.post('/api/admin-chats/:roomId/lock', ...routeMiddleware, async (req, res) => {
        try {
            const actingUid = req.uid;
            const roomId = parseInt(req.params.roomId, 10);

            if (!actingUid || Number.isNaN(roomId)) {
                return res.status(400).json({ status: { code: 'bad-request', message: 'Invalid room id' } });
            }

            if (!await User.isAdministrator(actingUid) && !await canManageAdminChats(actingUid)) {
                return res.status(403).json({ status: { code: 'forbidden', message: 'Admin or manage privilege required' } });
            }

            if (!await roomExists(roomId)) {
                return res.status(404).json({ status: { code: 'not-found', message: 'Room not found' } });
            }

            const shouldLock = req.body && typeof req.body.locked === 'boolean' ? req.body.locked : true;
            const lockData = shouldLock ?
                await lockRoom(roomId, actingUid) :
                await unlockRoom(roomId, actingUid);

            return res.json({
                status: { code: 'ok', message: 'Room updated' },
                roomId,
                lockData,
            });
        } catch (err) {
            return res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });
}

async function renderAdminChatsPage(req, res, next) {
    if (meta.config.disableChat) {
        return next();
    }

    if (!await assertAdminChatsAccess(req, res)) {
        return;
    }

    const payload = await buildAdminChatsPayload(req);
    if (req.params.roomId && !payload.roomId) {
        return next();
    }

    res.render('chats', payload);
}

async function assertAdminChatsAccess(req, res) {
    if (!req.uid || !await canAccessAdminChats(req.uid)) {
        helpers.notAllowed(req, res);
        return false;
    }

    return true;
}

async function buildAdminChatsPayload(req) {
    const userslug = await User.getUserField(req.uid, 'userslug');
    const [isAdmin, canView, canManage] = await Promise.all([
        User.isAdministrator(req.uid),
        privileges.global.can(ADMIN_CHATS_PRIVILEGE, req.uid),
        privileges.global.can(ADMIN_CHATS_MANAGE_PRIVILEGE, req.uid),
    ]);
    const adminChatsManage = isAdmin || canManage;
    const adminChatsAccess = isAdmin || canView || canManage;
    const [recentChats, publicRooms, privateRoomCount] = await Promise.all([
        getAdminRecentChats(req.uid, 0, ADMIN_CHAT_PAGE_SIZE),
        Messaging.getPublicRooms(req.uid, req.uid),
        getPrivateRoomCount(),
    ]);

    const payload = {
        title: '[[pages:chats]]',
        uid: req.uid,
        userslug,
        adminAllChats: true,
        adminChatsAccess,
        adminChatsIsAdmin: isAdmin,
        adminChatsCanManage: adminChatsManage,
        rooms: recentChats.rooms,
        nextStart: recentChats.nextStart,
        publicRooms: publicRooms || [],
        privateRoomCount,
        bodyClasses: ['page-user-chats'],
    };

    const roomId = parseInt(req.params.roomId, 10) || 0;
    if (!roomId) {
        return payload;
    }

    const roomPayload = await buildAdminChatRoomPayload(req.uid, roomId, req.params.index);
    if (!roomPayload) {
        return payload;
    }

    return {
        ...payload,
        ...roomPayload,
    };
}

async function buildAdminChatRoomPayload(uid, roomId, indexParam) {
    let start = 0;
    let scrollToIndex = null;

    if (indexParam) {
        const msgCount = await db.getObjectField(`chat:room:${roomId}`, 'messageCount');
        start = Math.max(0, parseInt(msgCount, 10) - parseInt(indexParam, 10) - 49);
        scrollToIndex = Math.min(msgCount, Math.max(0, parseInt(indexParam, 10) || 1));
    }

    const room = await Messaging.loadRoom(uid, {
        uid,
        roomId,
        start,
    });

    if (!room) {
        return null;
    }

    const [canViewInfo, canUploadImage, canUploadFile] = await privileges.global.can([
        'view:users:info', 'upload:post:image', 'upload:post:file',
    ], uid);

    room.title = room.roomName || room.usernames || '[[pages:chats]]';
    room.bodyClasses = ['page-user-chats', 'chat-loaded'];
    room.canViewInfo = canViewInfo;
    room.canUpload = (canUploadImage || canUploadFile) && (meta.config.maximumFileSize > 0 || room.isAdmin);
    room.scrollToIndex = scrollToIndex;

    return room;
}

async function getPrivateRoomCount() {
    const [totalCount, publicCount] = await Promise.all([
        db.sortedSetCard('chat:rooms'),
        db.sortedSetCard('chat:rooms:public'),
    ]);

    return Math.max(0, (parseInt(totalCount, 10) || 0) - (parseInt(publicCount, 10) || 0));
}

async function getAdminRecentChats(uid, start, limit) {
    let cursor = Math.max(0, parseInt(start, 10) || 0);
    const roomPairs = [];

    while (roomPairs.length < limit) {
        const roomIds = await db.getSortedSetRevRange('chat:rooms', cursor, cursor + ADMIN_CHAT_SCAN_SIZE - 1);
        if (!roomIds.length) {
            break;
        }

        const rooms = await Messaging.getRoomsData(roomIds);
        rooms.forEach((room, index) => {
            if (room && !room.public && roomPairs.length < limit) {
                roomPairs.push({
                    roomId: roomIds[index],
                    room,
                });
            }
        });

        cursor += roomIds.length;
        if (roomIds.length < ADMIN_CHAT_SCAN_SIZE) {
            break;
        }
    }

    const rooms = roomPairs.map(item => item.room);
    const roomIds = roomPairs.map(item => item.roomId);

    await enrichAdminRecentRooms(uid, roomIds, rooms);

    return {
        rooms,
        nextStart: cursor,
    };
}

async function enrichAdminRecentRooms(uid, roomIds, rooms) {
    if (!roomIds.length) {
        return;
    }

    const roomUsers = await Promise.all(roomIds.map(roomId => Messaging.getUidsInRoom(roomId, 0, -1)));
    const uniqueUids = [...new Set(roomUsers.flat().filter(Boolean))];
    const userMap = new Map();

    if (uniqueUids.length) {
        const users = await User.getUsersFields(uniqueUids, [
            'uid', 'username', 'userslug', 'displayname', 'picture', 'status', 'lastonline',
        ]);
        uniqueUids.forEach((memberUid, index) => {
            const userData = users[index];
            if (userData) {
                userData.status = User.getStatus(userData);
                userMap.set(String(memberUid), userData);
            }
        });
    }

    const teasers = await Promise.all(roomIds.map(roomId => getAdminRoomTeaser(roomId)));

    rooms.forEach((room, index) => {
        if (!room) {
            return;
        }

        room.users = (roomUsers[index] || [])
            .map(memberUid => userMap.get(String(memberUid)))
            .filter(Boolean);
        room.groupChat = room.userCount > 2;
        room.unread = false;
        room.teaser = teasers[index];
        room.lastUser = room.users[0];
        room.usernames = Messaging.generateUsernames(room, uid);
        room.participantsLabel = buildParticipantsLabel(room.users);
        room.icon = Messaging.getRoomIcon(room);
    });
}

function buildParticipantsLabel(users) {
    const list = Array.isArray(users) ? users.filter(Boolean) : [];
    if (!list.length) {
        return '';
    }

    const names = list.map(user => user.displayname || user.username).filter(Boolean);
    if (names.length <= 5) {
        return names.join(', ');
    }

    return `${names.slice(0, 5).join(', ')} +${names.length - 5}`;
}

async function getAdminRoomTeaser(roomId) {
    const mids = await db.getSortedSetRevRange(`chat:room:${roomId}:mids`, 0, 19);
    if (!mids.length) {
        return null;
    }

    const teaser = (await Messaging.getMessagesFields(mids, ['fromuid', 'content', 'timestamp', 'deleted', 'system']))
        .find(message => message && !message.deleted && !message.system && message.fromuid);

    if (!teaser) {
        return null;
    }

    const teaserUser = await User.getUserFields(teaser.fromuid, [
        'uid', 'username', 'userslug', 'displayname', 'picture', 'status', 'lastonline',
    ]);

    if (teaserUser) {
        teaser.user = teaserUser;
    }

    teaser.content = String(teaser.content || '')
        .replace(/<[^>]*>/g, '')
        .trim();
    teaser.roomId = roomId;

    return teaser;
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
async function roomExists(roomId) {
    const roomData = await db.getObject(`chat:room:${roomId}`);
    return !!roomData;
}

async function lockRoom(roomId, actingUid) {
    const now = Date.now();
    await db.setObject(`chat:room:${roomId}:adminLock`, {
        isLocked: 1,
        lockedBy: actingUid,
        lockedAt: now,
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

async function getMessageRoomId(messageId) {
    const roomId = await db.getObjectField(`message:${messageId}`, 'roomId');
    return parseInt(roomId, 10) || 0;
}

async function getRoomLockData(roomId) {
    const data = await db.getObject(`chat:room:${roomId}:adminLock`) || {};
    const lockedBy = parseInt(data.lockedBy, 10) || 0;
    const lockedAt = parseInt(data.lockedAt, 10) || 0;
    const isLockedValue = data.isLocked === '1' || data.isLocked === 1 || data.isLocked === true;

    return {
        isLocked: isLockedValue,
        lockedBy,
        lockedAt,
    };
}

function ensureFirstVisibleMessageHeader(messages) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    const firstUserMessageIndex = list.findIndex(msg => msg && !msg.system);

    if (firstUserMessageIndex !== -1) {
        list[firstUserMessageIndex].newSet = true;
    }

    return list;
}

function buildRoomMessagesWithLockNotice(messages, lockData) {
    const cleanedMessages = stripAdminLockMessages(messages);
    if (!lockData || !lockData.isLocked || !lockData.lockedAt) {
        return cleanedMessages;
    }

    cleanedMessages.push({
        content: `${LOCK_PREFIX} ${LOCKED_MESSAGE_TEXT}`,
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

function stripAdminLockMessages(messages) {
    const list = Array.isArray(messages) ? messages.slice() : [];
    return list.filter(msg => !isAdminLockMessage(msg));
}

function isAdminLockMessage(msg) {
    const content = String(msg && msg.content || '');
    return content.includes('admin-chat-lock') ||
        content.includes(LOCKED_MESSAGE_TEXT) ||
        content.includes('נפתח מחדש ע"י המנהלים') ||
        content.includes('modules:chat.system.[admin-chat-lock]');
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

module.exports = plugin;
