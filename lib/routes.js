'use strict';

const User = require.main.require('./src/user');
const Messaging = require.main.require('./src/messaging');
const db = require.main.require('./src/database');
const meta = require.main.require('./src/meta');
const privileges = require.main.require('./src/privileges');
const helpers = require.main.require('./src/controllers/helpers');
const validator = require.main.require('validator');
const sockets = require.main.require('./src/socket.io');

const { canAccessAdminChats, canManageAdminChats } = require('./access');
const { getMessageEditHistory, renderMessageHistoryHtml } = require('./history');
const { roomExists, lockRoom, unlockRoom, getRoomLockData } = require('./lock');

const ADMIN_CHAT_PAGE_SIZE = 30;
const ADMIN_CHAT_SCAN_SIZE = 100;

async function assertAdminChatsAccess(req, res) {
    if (!req.uid || !await canAccessAdminChats(req.uid)) {
        helpers.notAllowed(req, res);
        return false;
    }

    return true;
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

async function buildAdminChatsPayload(req, options = {}) {
    // Like core (controllers/accounts/chats.js): when the client only switches
    // rooms (?switch=1 on the JSON endpoint), skip rebuilding the room list —
    // scanning every chat room on each switch made room-opening slow on mobile
    const isSwitch = !!options.isSwitch;
    const userslug = await User.getUserField(req.uid, 'userslug');

    const payload = {
        title: '[[pages:chats]]',
        uid: req.uid,
        userslug,
        adminAllChats: true,
        bodyClasses: ['page-user-chats'],
    };

    if (!isSwitch) {
        const [recentChats, publicRooms, privateRoomCount] = await Promise.all([
            getAdminRecentChats(req.uid, 0, ADMIN_CHAT_PAGE_SIZE),
            Messaging.getPublicRooms(req.uid, req.uid),
            getPrivateRoomCount(),
        ]);
        payload.rooms = recentChats.rooms;
        payload.nextStart = recentChats.nextStart;
        payload.publicRooms = publicRooms || [];
        payload.privateRoomCount = privateRoomCount;
    }

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

    const room = await Messaging.loadRoom(uid, { uid, roomId, start });
    if (!room) {
        return null;
    }

    // Root fix for "message stays unread": core only clears unread state from the
    // client when the room's nav element carries the `unread` class, which the
    // admin list never sets. Mark the room read for the viewer on every load.
    try {
        await Messaging.markRead(uid, roomId);
        await Messaging.pushUnreadCount(uid);
    } catch (err) {
        // never let read-state bookkeeping break room rendering
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
                roomPairs.push({ roomId: roomIds[index], room });
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

    return { rooms, nextStart: cursor };
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

    teaser.content = String(teaser.content || '').replace(/<[^>]*>/g, '').trim();
    teaser.roomId = roomId;

    return teaser;
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
            // Users without admin-chats access get core's behaviour: redirect to
            // their own chats page (helpers.redirect also handles API/ajaxify
            // requests via X-Redirect, so navigation works in one hop)
            if (req.uid && !await canAccessAdminChats(req.uid)) {
                const userSlug = await User.getUserField(req.uid, 'userslug');
                if (userSlug) {
                    const suffix = req.params.roomId ? `/${req.params.roomId}${req.params.index ? `/${req.params.index}` : ''}` : '';
                    return helpers.redirect(res, `/user/${userSlug}/chats${suffix}`);
                }
            }

            await renderAdminChatsPage(req, res, next);
        } catch (err) {
            next(err);
        }
    };

    const pageRouter = app || router;
    pageRouter.get('/chats/:roomId?/:index?', middleware.busyCheck, pageMiddlewares, middleware.buildHeader, pageController);
    // Also own the page-API route. Without it, ajaxify entry into /chats/<roomId>
    // (e.g. picking a room from the mobile chat dropdown) hit core's redirect
    // route and bounced through an extra hop before the room finally rendered —
    // showing the chat list in between. Registered on the core router before
    // core's own routes, and covered by middleware.prepareAPI (mounted earlier),
    // so res.render answers with ajaxify JSON in a single round-trip.
    router.get('/api/chats/:roomId?/:index?', pageMiddlewares, pageController);

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

    router.get('/api/admin-chats/page/:roomId?/:index?', ...routeMiddleware, async (req, res) => {
        try {
            if (!await assertAdminChatsAccess(req, res)) {
                return;
            }

            const payload = await buildAdminChatsPayload(req, { isSwitch: parseInt(req.query.switch, 10) === 1 });
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
            const lockData = shouldLock ? await lockRoom(roomId, actingUid) : await unlockRoom(roomId, actingUid);

            // Push the new lock state to anyone with that room open right now —
            // same broadcast pattern core uses for messages (src/messaging/notifications.js),
            // so an open window updates live instead of relying on client-side polling.
            sockets.in(`chat_room_${roomId}`).emit('event:admin-chats.roomLockChanged', { roomId, lockData });

            return res.json({ status: { code: 'ok', message: 'Room updated' }, roomId, lockData });
        } catch (err) {
            return res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    router.get('/api/admin-chats/:roomId/lock', ...routeMiddleware, async (req, res) => {
        try {
            const roomId = parseInt(req.params.roomId, 10);

            if (Number.isNaN(roomId)) {
                return res.status(400).json({ status: { code: 'bad-request', message: 'Invalid room id' } });
            }

            if (!await roomExists(roomId)) {
                return res.status(404).json({ status: { code: 'not-found', message: 'Room not found' } });
            }

            const lockData = await getRoomLockData(roomId);
            return res.json({ status: { code: 'ok', message: 'Lock data retrieved' }, roomId, lockData });
        } catch (err) {
            return res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    // --- Hidden chat edit-history viewer ---------------------------------
    // These two routes are intentionally NOT referenced from any template,
    // client script, menu or API payload. They do not appear in the admin
    // chats UI, so a "regular" administrator who has not read this source
    // will never encounter them. They are still protected by
    // assertAdminChatsAccess(), so only privileged accounts can read data
    // even if the URL is discovered. Paths:
    //   GET /api/admin-chats/history/:mid   -> JSON
    //   GET /admin-chats/history/:mid       -> standalone HTML page
    router.get('/api/admin-chats/history/:mid', ...routeMiddleware, async (req, res) => {
        try {
            if (!await assertAdminChatsAccess(req, res)) {
                return;
            }

            const mid = parseInt(req.params.mid, 10);
            if (Number.isNaN(mid)) {
                return res.status(400).json({ status: { code: 'bad-request', message: 'Invalid message id' } });
            }

            const history = await getMessageEditHistory(mid);
            return res.json({ status: { code: 'ok', message: 'Edit history retrieved' }, ...history });
        } catch (err) {
            return res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    router.get('/admin-chats/history/:mid', ...routeMiddleware, async (req, res) => {
        try {
            if (!await assertAdminChatsAccess(req, res)) {
                return;
            }

            const mid = parseInt(req.params.mid, 10);
            if (Number.isNaN(mid)) {
                return res.status(400).type('html').send('<h1>400</h1><p>Invalid message id</p>');
            }

            const history = await getMessageEditHistory(mid);
            return res.type('html').send(renderMessageHistoryHtml(history));
        } catch (err) {
            return res.status(500).type('html').send(`<h1>500</h1><pre>${validator.escape(String(err.message))}</pre>`);
        }
    });
}

module.exports = {
    ADMIN_CHAT_PAGE_SIZE,
    assertAdminChatsAccess,
    renderAdminChatsPage,
    buildAdminChatsPayload,
    buildAdminChatRoomPayload,
    getAdminRecentChats,
    buildParticipantsLabel,
    registerRoutes,
};
