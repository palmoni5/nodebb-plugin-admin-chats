'use strict';

// Pushes room-lock changes to anyone with that room open, instead of the
// previous approach of polling every open chat window on a timer. The
// server emits event:admin-chats.roomLockChanged to chat_room_<roomId> from
// lib/routes.js's lock endpoint (mirrors core's own room broadcast pattern
// in src/messaging/notifications.js).
$(document).ready(function () {
    function refreshIfOpen(roomId) {
        const activeRoomId = parseInt($('[component="chat/main-wrapper"]').attr('data-roomid'), 10) || 0;
        if (activeRoomId !== parseInt(roomId, 10)) {
            return;
        }

        require(['forum/chats'], function (Chats) {
            if (Chats && Chats.switchChat) {
                Chats.switchChat(roomId);
            }
        });
    }

    if (window.socket) {
        socket.removeListener('event:admin-chats.roomLockChanged', refreshIfOpen);
        socket.on('event:admin-chats.roomLockChanged', function (data) {
            refreshIfOpen(data && data.roomId);
        });
    }

    // Core toggles the `deleted` class on a message when it's deleted/restored,
    // but doesn't itself swap which of the delete/restore actions is visible.
    $(document).on('click', '[data-action="delete"], [data-action="restore"]', function () {
        const $message = $(this).closest('[component="chat/message"]');
        if (!$message.length) {
            return;
        }
        setTimeout(function () {
            const isDeleted = $message.hasClass('deleted');
            $message.find('[data-action="delete"]').toggleClass('hidden', isDeleted).toggle(!isDeleted);
            $message.find('[data-action="restore"]').toggleClass('hidden', !isDeleted).toggle(isDeleted);
        }, 50);
    });
});
