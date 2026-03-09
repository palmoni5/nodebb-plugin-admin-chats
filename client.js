$(document).ready(function() {
    const LOCK_PREFIX = '[admin-chat-lock]';
    const roomStateCache = new Map();
    const TEXT = {
        he: {
            lockBanner: '🔒 חדר זה ננעל ע"י המנהלים.',
            menuLock: 'נעל חדר',
            menuRelease: 'שחרר נעילה',
            updateError: 'לא ניתן לעדכן את נעילת החדר.',
            viewChats: "צפיה בצ'אטים",
            emptyState: "אנא בחר צ'אט מסרגל הצד.",
            lockedAction: 'לא ניתן לבצע פעולה זו בחדר נעול',
        },
        en: {
            lockBanner: '🔒 This room was locked by the administrators.',
            menuLock: 'Lock Room',
            menuRelease: 'Release Lock',
            updateError: 'Unable to update room lock.',
            viewChats: 'View Chats',
            emptyState: 'Please select a chat from the sidebar.',
            lockedAction: 'This action cannot be performed in a locked room.',
        },
    };

    function isEnglishSystem() {
        return $('html').attr('lang') && $('html').attr('lang').startsWith('en');
    }

    function t(key) {
        const dict = isEnglishSystem() ? TEXT.en : TEXT.he;
        return dict[key];
    }

    function replaceAdminEmptyStateText() {
        if (!app.user.isAdmin) {
            return;
        }

        $('span.text-muted.text-sm').each(function() {
            const currentText = $(this).text().trim();
            if (
                currentText.includes("אין לכם צ'אטים פעילים") ||
                currentText === "אין לכם צ'אטים פעילים." ||
                currentText.includes('You have no active chats') ||
                currentText === 'You have no active chats.'
            ) {
                $(this).text(t('emptyState'));
                $(this).removeClass('text-muted');
            }
        });
    }

    function getChatWindows() {
        return $('[component="chat/message/window"]');
    }

    function getWindowRoomId($window) {
        const roomId = $window.find('[component="chat/messages"]').first().attr('data-roomid') ||
            $window.closest('.chat-modal').attr('data-roomid') ||
            (ajaxify && ajaxify.data && ajaxify.data.roomId);
        return parseInt(roomId, 10) || 0;
    }

    function getCachedRoomData(roomId) {
        const cached = roomStateCache.get(String(roomId));
        if (!cached) {
            return null;
        }
        if (Date.now() - cached.timestamp > 10000) {
            roomStateCache.delete(String(roomId));
            return null;
        }
        return cached.data;
    }

    function setCachedRoomData(roomId, data) {
        roomStateCache.set(String(roomId), {
            data,
            timestamp: Date.now(),
        });
    }

    async function fetchRoomData(roomId) {
        if (!roomId) {
            return null;
        }

        const currentRoom = ajaxify && ajaxify.data && (ajaxify.data.room || ajaxify.data);
        if (currentRoom && parseInt(currentRoom.roomId, 10) === roomId && currentRoom.adminChatLock) {
            setCachedRoomData(roomId, currentRoom);
            return currentRoom;
        }

        const cached = getCachedRoomData(roomId);
        if (cached) {
            return cached;
        }

        const response = await fetch(`${config.relative_path || ''}/api/chats/${roomId}`, {
            headers: {
                'x-csrf-token': config.csrf_token,
            },
            credentials: 'same-origin',
        });
        if (!response.ok) {
            return null;
        }

        const payload = await response.json();
        const roomData = payload && payload.roomId ? payload : (payload && payload.room ? payload.room : null);
        if (roomData) {
            setCachedRoomData(roomId, roomData);
        }
        return roomData;
    }

    function isLockedForUser(roomData) {
        return !!(roomData && roomData.adminChatLock && roomData.adminChatLock.isLocked && !(app.user && app.user.isAdmin));
    }

    function setComposerHidden($window, hidden) {
        $window.find('[component="chat/composer"]').each(function() {
            const $composer = $(this);
            if (hidden) {
                $composer.addClass('hidden').hide();
            } else {
                $composer.removeClass('hidden').show();
            }
        });

        $window.find('[component="chat/input"], [component="chat/send"], button[data-action="send"], textarea.chat-input')
            .prop('disabled', hidden)
            .attr('disabled', hidden ? 'disabled' : null);
    }

    function renderLockBanner($window, hidden) {
        $window.find('.admin-chat-lock-banner').remove();
        if (!hidden) {
            return;
        }

        const target = $window.find('[component="chat/messages"]').first();
        if (!target.length) {
            return;
        }

        const positionStyle = isEnglishSystem() ? 'float:right; clear:both;' : 'float:left; clear:both;';
        target.prepend(`<div class="admin-chat-lock-banner alert alert-warning mb-2 text-start" style="${positionStyle} max-width: fit-content;">${t('lockBanner')}</div>`);
    }

    function updateLockedActionVisibility($window, hidden) {
        [
            '[data-action="reply"]',
            '[data-action="edit"]',
            '[data-action="delete"]',
            '[data-action="restore"]',
            '[data-action="kick"]',
            '[data-action="toggleOwner"]'
        ].forEach(function(selector) {
            $window.find(selector).toggleClass('hidden', hidden).toggle(!hidden);
        });

        $window.find('[component="chat/controlsToggle"]').closest('.dropdown').toggleClass('hidden', hidden).toggle(!hidden);
        $window.find('[component="chat/manage/user/add/search"], [component="chat/manage/user/list/search"], [component="chat/manage/save"]')
            .toggleClass('hidden', hidden)
            .toggle(!hidden)
            .prop('disabled', hidden)
            .attr('disabled', hidden ? 'disabled' : null);
        $window.find('[component="chat/manage-modal"] .form-text, [component="chat/manage-modal"] .text-danger')
            .toggleClass('hidden', hidden);
    }

    function normalizeLockMessages($window) {
        $window.find('[component="chat/system-message"] > div').each(function() {
            const $el = $(this);
            const text = $el.text().trim();
            if (!text.includes(LOCK_PREFIX.slice(1, -1)) && !text.includes('admin-chat-lock')) {
                return;
            }
            $el.text(t('lockBanner'));
        });
    }

    function getRoomMenuTargets($window) {
        const scoped = $window.find('[component="chat/controls"]');
        if (scoped.length) {
            return scoped;
        }
        return $window.find('[component="chat/header"], .chat-header, .modal-header, [component="chat/nav"]').find('.dropdown-menu');
    }

    function renderAdminLockControl($window, roomData) {
        $window.find('.admin-chat-lock-toggle-item, .admin-chat-lock-divider, .admin-chat-lock-item-wrap').remove();

        if (!app.user.isAdmin || !roomData || !roomData.roomId) {
            return;
        }

        const menus = getRoomMenuTargets($window);
        if (!menus.length) {
            return;
        }

        const lockData = roomData.adminChatLock || {};
        const isLocked = !!lockData.isLocked;
        const itemText = isLocked ? t('menuRelease') : t('menuLock');
        const iconClass = isLocked ? 'fa-lock-open' : 'fa-lock';
        const menuItemHtml = `
            <li role="presentation" class="admin-chat-lock-item-wrap">
                <a href="#" role="menuitem" class="dropdown-item rounded-1 d-flex align-items-center gap-2 admin-chat-lock-toggle-item" data-room-id="${roomData.roomId}" data-locked="${isLocked}">
                    <i class="fa fa-fw ${iconClass}"></i>
                    <span>${itemText}</span>
                </a>
            </li>
            <li role="presentation" class="dropdown-divider admin-chat-lock-divider"></li>
        `;

        menus.each(function() {
            const $menu = $(this);
            if ($menu.find('.admin-chat-lock-toggle-item').length) {
                return;
            }
            $menu.prepend(menuItemHtml);
        });
    }

    async function applyUiToWindow($window) {
        const roomId = getWindowRoomId($window);
        if (!roomId) {
            return;
        }

        const roomData = await fetchRoomData(roomId);
        if (!roomData) {
            return;
        }

        const hidden = isLockedForUser(roomData);
        setComposerHidden($window, hidden);
        updateLockedActionVisibility($window, hidden);
        renderLockBanner($window, hidden);
        renderAdminLockControl($window, roomData);
        normalizeLockMessages($window);
    }

    async function refreshChatUi() {
        replaceAdminEmptyStateText();
        const windows = getChatWindows();
        await Promise.all(windows.map(function() {
            return applyUiToWindow($(this));
        }).get());
    }

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

    $(window).on('action:ajaxify.end', function(ev, data) {
        const templateName = ajaxify && ajaxify.data && ajaxify.data.template ? ajaxify.data.template.name : '';

        if (app.user.isAdmin && templateName.startsWith('account/')) {
            const userSlug = ajaxify.data.userslug || (ajaxify.data.user && ajaxify.data.user.userslug);

            if (userSlug) {
                const relativePath = config.relative_path || '';
                const btnHtml = `
                    <li role="presentation">
                        <a class="dropdown-item rounded-1 d-flex align-items-center gap-2" href="${relativePath}/user/${userSlug}/chats" role="menuitem">
                            <i class="far fa-fw fa-comments"></i>
                            <span>${t('viewChats')}</span>
                        </a>
                    </li>
                    <li role="presentation" class="dropdown-divider"></li>
                `;
                const menu = $('.account-sub-links');
                if (menu.length) {
                    menu.find(`a[href*="/user/${userSlug}/chats"]`).parent().remove();
                    menu.prepend(btnHtml);
                }
            }
        }

        const url = data && data.url ? data.url : '';
        if (url.match(/^user\/.+\/chats/) || url === 'chats') {
            refreshChatUi();
            setTimeout(refreshChatUi, 500);
            setTimeout(refreshChatUi, 1200);
        }
    });

    $(window).on('action:chat.loaded', function() {
        refreshChatUi();
        setTimeout(refreshChatUi, 200);
        setTimeout(refreshChatUi, 1000);
    });

    $(window).on('action:chat.closed', function() {
        setTimeout(refreshChatUi, 200);
    });

    $(window).on('action:chat.onMessagesAddedToDom action:chat.edited action:chat.renamed', function() {
        setTimeout(refreshChatUi, 0);
    });

    $(document).on('click', '.admin-chat-lock-toggle-item', async function(ev) {
        ev.preventDefault();

        const $button = $(this);
        const roomId = parseInt($button.attr('data-room-id'), 10);
        const isLocked = $button.attr('data-locked') === 'true';

        if (!roomId) {
            return;
        }

        $button.addClass('disabled').attr('aria-disabled', 'true');

        try {
            const result = await toggleRoomLock(roomId, !isLocked);
            const currentRoom = ajaxify && ajaxify.data && (ajaxify.data.room || ajaxify.data);
            if (currentRoom && parseInt(currentRoom.roomId, 10) === roomId) {
                currentRoom.adminChatLock = result.lockData;
                currentRoom.canReply = !result.lockData.isLocked || (app.user && app.user.isAdmin);
                currentRoom.showUserInput = currentRoom.canReply;
                if (ajaxify.data.room) {
                    ajaxify.data.room.adminChatLock = result.lockData;
                    ajaxify.data.room.canReply = currentRoom.canReply;
                    ajaxify.data.room.showUserInput = currentRoom.showUserInput;
                }
            }

            const cached = getCachedRoomData(roomId) || { roomId };
            cached.adminChatLock = result.lockData;
            cached.canReply = !result.lockData.isLocked || (app.user && app.user.isAdmin);
            cached.showUserInput = cached.canReply;
            setCachedRoomData(roomId, cached);
            await refreshChatUi();
        } catch (err) {
            app.alertError(t('updateError'));
            $button.removeClass('disabled').removeAttr('aria-disabled');
        }
    });

    // Intercept error alerts to translate locked action errors
    if (app && app.alertError) {
        const originalAlertError = app.alertError;
        app.alertError = function(error) {
            let message = error;
            if (typeof error === 'object' && error.message) {
                message = error.message;
            }
            if (typeof message === 'string' && message.includes('admin-chats:errors.lockedAction')) {
                message = t('lockedAction');
            }
            return originalAlertError.call(this, message);
        };
    }

    // Intercept and translate error messages from API
    if (app.alertError && !app.alertError._adminChatsWrapped) {
        const originalAlertError = app.alertError;
        app.alertError = function(message) {
            if (typeof message === 'string') {
                // Check if message contains translation key
                if (message.includes('[[admin-chats:errors.lockedAction]]') || message.includes('errors.lockedAction')) {
                    message = t('lockedAction');
                }
            }
            return originalAlertError.call(this, message);
        };
        app.alertError._adminChatsWrapped = true;
    }
});
