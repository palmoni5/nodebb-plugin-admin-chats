'use strict';

const User = nodebb.require('./src/user');
const Messaging = nodebb.require('./src/messaging');
const db = nodebb.require('./src/database');
const meta = nodebb.require('./src/meta');
const privileges = nodebb.require('./src/privileges');
const helpers = nodebb.require('./src/controllers/helpers');
const sockets = nodebb.require('./src/socket.io');

const { canAccessAdminChats, canManageAdminChats } = require('./access');
const { getMessageEditHistory, deleteRevision } = require('./history');
const { roomExists, lockRoom, unlockRoom, getRoomLockData } = require('./lock');
const { ACTIVITY_SET, pruneActivityEntries } = require('./activity');

const ADMIN_CHAT_PAGE_SIZE = 30;

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
    const cursor = Math.max(0, parseInt(start, 10) || 0);

    // The activity set is scored by each room's last message (see lib/activity.js),
    // so a plain reverse range yields the same most-recent-first ordering the
    // user's own chats page gets from `uid:<uid>:chat:rooms`.
    const allRoomIds = await db.getSortedSetRevRange(ACTIVITY_SET, cursor, cursor + limit - 1);
    const allRooms = await Messaging.getRoomsData(allRoomIds);

    const roomPairs = [];
    const staleRoomIds = [];
    allRooms.forEach((room, index) => {
        if (room && !room.public) {
            roomPairs.push({ roomId: allRoomIds[index], room });
        } else if (!room) {
            staleRoomIds.push(allRoomIds[index]);
        }
    });

    await pruneActivityEntries(staleRoomIds);

    const rooms = roomPairs.map(item => item.room);
    const roomIds = roomPairs.map(item => item.roomId);

    await enrichAdminRecentRooms(uid, roomIds, rooms);

    return { rooms, nextStart: cursor + allRoomIds.length };
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

    // --- Chat edit-history (message options menu) -------------------------
    // Surfaced as an "Edit history" item in each message's options dropdown
    // (templates/partials/chats/message.tpl + static/lib/message-history.js),
    // mirroring core's post diffs modal. Both routes require the manage
    // privilege — view-only admin-chats access is not enough.
    //   GET    /api/admin-chats/history/:mid          -> JSON
    //   DELETE /api/admin-chats/history/:mid/:index   -> delete one revision
    router.get('/api/admin-chats/history/:mid', ...routeMiddleware, async (req, res) => {
        try {
            if (!req.uid || !await canManageAdminChats(req.uid)) {
                return res.status(403).json({ status: { code: 'forbidden', message: 'Manage privilege required' } });
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

    // Restore a revision — like core post diffs (src/posts/diffs.js Diffs.restore),
    // restoring is just an edit that sets the message content back to the
    // revision's content. Going through Messaging.editMessage means the
    // replaced current version is snapshotted into history (lib/overrides.js)
    // and open chat windows update live via core's edit broadcast.
    router.put('/api/admin-chats/history/:mid/:index', ...routeMiddleware, async (req, res) => {
        try {
            if (!req.uid || !await canManageAdminChats(req.uid)) {
                return res.status(403).json({ status: { code: 'forbidden', message: 'Manage privilege required' } });
            }

            const mid = parseInt(req.params.mid, 10);
            const index = parseInt(req.params.index, 10);
            if (Number.isNaN(mid) || Number.isNaN(index) || index < 0) {
                return res.status(400).json({ status: { code: 'bad-request', message: 'Invalid message id or revision index' } });
            }

            const history = await getMessageEditHistory(mid);
            if (!history.exists) {
                return res.status(404).json({ status: { code: 'not-found', message: 'Message not found' } });
            }
            if (index >= history.revisions.length) {
                return res.status(404).json({ status: { code: 'not-found', message: 'Revision not found' } });
            }

            await Messaging.editMessage(req.uid, mid, history.roomId, history.revisions[index].content);

            const fresh = await getMessageEditHistory(mid);
            return res.json({ status: { code: 'ok', message: 'Revision restored' }, ...fresh });
        } catch (err) {
            return res.status(500).json({ status: { code: 'error', message: err.message } });
        }
    });

    router.delete('/api/admin-chats/history/:mid/:index', ...routeMiddleware, async (req, res) => {
        try {
            if (!req.uid || !await canManageAdminChats(req.uid)) {
                return res.status(403).json({ status: { code: 'forbidden', message: 'Manage privilege required' } });
            }

            const mid = parseInt(req.params.mid, 10);
            const index = parseInt(req.params.index, 10);
            if (Number.isNaN(mid) || Number.isNaN(index) || index < 0) {
                return res.status(400).json({ status: { code: 'bad-request', message: 'Invalid message id or revision index' } });
            }

            const deleted = await deleteRevision(mid, index);
            if (!deleted) {
                return res.status(404).json({ status: { code: 'not-found', message: 'Revision not found' } });
            }

            const history = await getMessageEditHistory(mid);
            return res.json({ status: { code: 'ok', message: 'Revision deleted' }, ...history });
        } catch (err) {
            return res.status(500).json({ status: { code: 'error', message: err.message } });
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
