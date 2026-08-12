'use strict';

// The lock/unlock menu item itself is rendered server-side
// (templates/partials/chats/options.tpl, gated on isAdminOrGlobalMod) — this
// only wires the click. The resulting UI state (composer, per-message
// actions, banner) all comes from the server re-render below, not from
// client-side DOM patching.
$(document).ready(function () {
    async function toggleRoomLock(roomId, nextState) {
        const response = await fetch(`${config.relative_path || ''}/api/admin-chats/${roomId}/lock`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': config.csrf_token,
            },
            body: JSON.stringify({ locked: nextState }),
            credentials: 'same-origin',
        });

        if (!response.ok) {
            throw new Error('Unable to update room lock');
        }

        return await response.json();
    }

    $(document).on('click', '.admin-chat-lock-toggle-item', async function (ev) {
        ev.preventDefault();

        const $button = $(this);
        const roomId = parseInt($button.attr('data-room-id'), 10);
        const isLocked = $button.attr('data-locked') === 'true';

        if (!roomId) {
            return;
        }

        $button.addClass('disabled').attr('aria-disabled', 'true');

        try {
            await toggleRoomLock(roomId, !isLocked);
            // The lock/unlock menu item, composer visibility and per-message
            // action buttons are all rendered server-side from the fresh
            // room data, so re-switch to this room to pick it up. Other
            // clients with the room open get the same refresh via the
            // event:admin-chats.roomLockChanged broadcast (static/lib/live-updates.js).
            require(['forum/chats'], function (Chats) {
                if (Chats && Chats.switchChat) {
                    Chats.switchChat(roomId);
                }
            });
        } catch (err) {
            app.alertError('[[admin-chats:errors.update]]');
            $button.removeClass('disabled').removeAttr('aria-disabled');
        }
    });
});
