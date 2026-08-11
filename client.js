$(document).ready(function() {
    
    // Initialize translations object if not already set
    if (!window.adminChatsTranslations) {
        window.adminChatsTranslations = {};
    }
    
    
    // Get translations from ajaxify.data if available
    if (ajaxify.data && ajaxify.data.adminChatsTranslations) {
        window.adminChatsTranslations = ajaxify.data.adminChatsTranslations;
        window.adminChatsLanguage = ajaxify.data.adminChatsLanguage;
        window.adminChatsAccess = ajaxify.data.adminChatsAccess;
        window.adminChatsIsAdmin = ajaxify.data.adminChatsIsAdmin;
        window.adminChatsCanManage = ajaxify.data.adminChatsCanManage;
    }
    
    syncAdminAccessFromAjaxify();
    fetchAdminPrivileges();
    const LOCK_PREFIX = '[admin-chat-lock]';
    const roomStateCache = new Map();

    function t(key) {
        // Get translation from server (from language files)
        if (window.adminChatsTranslations && window.adminChatsTranslations[key]) {
            return window.adminChatsTranslations[key];
        }
        // If translation not found, log warning and return the key itself
        return key;
    }
    
    function isEnglishSystem() {
        const lang = window.adminChatsLanguage || $('html').attr('lang') || 'en';
        const langCode = lang.split('-')[0];
        return langCode === 'en';
    }

    function hasAdminChatsAccess() {
        return !!((ajaxify && ajaxify.data && (ajaxify.data.adminChatsAccess || ajaxify.data.adminChatsCanManage)) || window.adminChatsAccess || window.adminChatsCanManage || (app.user && app.user.isAdmin));
    }

    function isAdminUser() {
        return !!((ajaxify && ajaxify.data && ajaxify.data.adminChatsIsAdmin) || window.adminChatsIsAdmin || (app.user && app.user.isAdmin));
    }

    async function fetchAdminPrivileges() {
        if (!hasAdminChatsAccess() || window.adminChatsPrivilegesPending) {
            return;
        }

        window.adminChatsPrivilegesPending = true;
        try {
            const response = await fetch(`${config.relative_path || ''}/api/admin-chats/privileges`, {
                headers: {
                    'x-csrf-token': config.csrf_token,
                },
                credentials: 'same-origin',
            });

            if (!response.ok) {
                return;
            }

            const payload = await response.json();
            if (payload && typeof payload.adminChatsAccess === 'boolean') {
                window.adminChatsAccess = payload.adminChatsAccess;
            }
            if (payload && typeof payload.adminChatsCanManage === 'boolean') {
                window.adminChatsCanManage = payload.adminChatsCanManage;
            }
            if (payload && typeof payload.adminChatsIsAdmin === 'boolean') {
                window.adminChatsIsAdmin = payload.adminChatsIsAdmin;
            }
        } catch (err) {
            // ignore
        } finally {
            window.adminChatsPrivilegesPending = false;
        }
    }

    function syncAdminAccessFromAjaxify() {
        if (!ajaxify || !ajaxify.data) {
            return;
        }
        if (typeof ajaxify.data.adminChatsAccess === 'boolean') {
            window.adminChatsAccess = ajaxify.data.adminChatsAccess;
        }
        if (typeof ajaxify.data.adminChatsCanManage === 'boolean') {
            window.adminChatsCanManage = ajaxify.data.adminChatsCanManage;
        }
        if (typeof ajaxify.data.adminChatsIsAdmin === 'boolean') {
            window.adminChatsIsAdmin = ajaxify.data.adminChatsIsAdmin;
        }
    }

    function canManageChats() {
        return !!((ajaxify && ajaxify.data && ajaxify.data.adminChatsCanManage) || window.adminChatsCanManage || isAdminUser());
    }

    let adminChatsAccessProbe = null;

    function resolveAdminChatsAccess() {
        if (hasAdminChatsAccess()) {
            return Promise.resolve(true);
        }
        if (window.adminChatsAccessChecked) {
            return Promise.resolve(false);
        }
        if (adminChatsAccessProbe) {
            return adminChatsAccessProbe;
        }

        adminChatsAccessProbe = fetch(`${config.relative_path || ''}/api/admin-chats?start=0`, {
            headers: {
                'x-csrf-token': config.csrf_token,
            },
            credentials: 'same-origin',
        }).then((response) => {
            const ok = response && response.ok;
            window.adminChatsAccess = ok;
            return ok;
        }).catch(() => {
            window.adminChatsAccess = false;
            return false;
        }).finally(() => {
            window.adminChatsAccessChecked = true;
            adminChatsAccessProbe = null;
        });

        return adminChatsAccessProbe;
    }

    // Get lockedAction message from server translations only (based on forum settings)
    function getLockedActionMessage() {
        if (window.adminChatsTranslations && window.adminChatsTranslations['errors.lockedAction']) {
            return window.adminChatsTranslations['errors.lockedAction'];
        }
        // If server translation not available, default to English
        return 'This action cannot be performed in a locked room.';
    }

    function isAdminAllChatsPage() {
        return !!(ajaxify && ajaxify.data && ajaxify.data.adminAllChats);
    }

    function getAdminChatsPageUrl(roomId) {
        return roomId ? `chats/${roomId}` : 'chats';
    }

    function getAdminChatsDataUrl(roomId) {
        const params = new URL(document.location).searchParams;
        params.set('switch', 1);
        const query = params.toString();
        return `${config.relative_path || ''}/api/admin-chats/page${roomId ? `/${roomId}` : ''}${query ? `?${query}` : ''}`;
    }

    async function loadMoreAdminChats() {
        const recentChats = $('[component="chat/recent"]');
        if (!isAdminAllChatsPage() || !recentChats.length || recentChats.attr('loading')) {
            return;
        }

        recentChats.attr('loading', 1);

        try {
            const start = parseInt(recentChats.attr('data-nextstart'), 10) || 0;
            const response = await fetch(`${config.relative_path || ''}/api/admin-chats?start=${start}`, {
                headers: {
                    'x-csrf-token': config.csrf_token,
                },
                credentials: 'same-origin',
            });

            if (!response.ok) {
                throw new Error('Unable to load chats');
            }

            const payload = await response.json();
            if (payload.rooms && payload.rooms.length) {
                payload.loadingMore = true;
                const html = await app.parseAndTranslate('chats', 'rooms', payload);
                recentChats.append(html);
                html.find('.timeago').timeago();
                recentChats.attr('data-nextstart', payload.nextStart);
            }
        } catch (err) {
            app.alertError(err);
        } finally {
            recentChats.removeAttr('loading');
        }
    }

    function bindAdminRecentChatsInfiniteScroll() {
        if (!isAdminAllChatsPage()) {
            return;
        }

        $('[component="chat/recent"]').off('scroll').on('scroll', utils.debounce(function() {
            const $this = $(this);
            const bottom = ($this[0].scrollHeight - $this.height()) * 0.9;
            if ($this.scrollTop() > bottom) {
                loadMoreAdminChats();
            }
        }, 100));
    }

    function patchForumChatsForAdminAll() {
        if (!isAdminAllChatsPage()) {
            return;
        }

        require(['forum/chats', 'forum/chats/messages'], function(Chats, ChatsMessages) {
            if (!Chats) {
                return;
            }

            if (!Chats._adminAllChatsPatched) {
                const originalSwitchChat = Chats.switchChat;

                Chats.switchChat = function(roomId) {
                    if (!isAdminAllChatsPage()) {
                        return originalSwitchChat.call(this, roomId);
                    }

                    roomId = roomId || '';
                    // NodeBB 4.14.9+ (56c6115a61): destroyAutoComplete takes the input element, not a roomId
                    Chats.destroyAutoComplete($('[component="chat/main-wrapper"]').find('[component="chat/input"]'));
                    if (ajaxify.data.roomId) {
                        socket.emit('modules.chats.leave', ajaxify.data.roomId);
                    }

                    const url = getAdminChatsPageUrl(roomId);
                    fetch(getAdminChatsDataUrl(roomId), { credentials: 'include' })
                        .then(async function(response) {
                            if (!response.ok) {
                                throw new Error(`Received ${response.status}`);
                            }

                            const payload = await response.json();
                            const html = await app.parseAndTranslate('partials/chats/message-window', payload);
                            const mainWrapper = $('[component="chat/main-wrapper"]');
                            mainWrapper.html(html);
                            mainWrapper.attr('data-roomid', roomId);
                            html.find('.timeago').timeago();
                            ajaxify.data = { ...ajaxify.data, ...payload, roomId: roomId };
                            ajaxify.updateTitle(ajaxify.data.title);
                            $('body').toggleClass('chat-loaded', !!roomId);
                            mainWrapper.find('[data-bs-toggle="tooltip"]').tooltip({ trigger: 'hover', container: '#content' });
                            Chats.setActive(roomId);
                            Chats.addEventListeners();
                            // Pass the container like core does — listeners (e.g. the emoji
                            // plugin's chat button) resolve elements relative to it
                            $(window).trigger('action:chat.loaded', $('.chats-full'));
                            if (roomId) {
                                ChatsMessages.scrollToBottomAfterImageLoad(mainWrapper.find('[component="chat/message/content"]'));
                            }
                            if (history.pushState) {
                                const fullUrl = `${window.location.protocol}//${window.location.host}${config.relative_path || ''}/${url}`;
                                // When the address bar already shows the target (e.g. closing a chat
                                // after a back-gesture), replace instead of stacking a duplicate entry
                                const sameUrl = window.location.href.split('?')[0] === fullUrl.split('?')[0];
                                history[sameUrl ? 'replaceState' : 'pushState']({ url: url }, null, fullUrl);
                            }
                            bindAdminRecentChatsInfiniteScroll();
                        });
                };

                Chats._adminAllChatsPatched = true;
            }

            // Auto-open chat if roomId is specified in URL and the room is not
            // already rendered (server-side render sets data-roomid on the wrapper —
            // re-switching in that case caused a visible list->chat flash on mobile)
            const currentRoomId = ajaxify && ajaxify.data && ajaxify.data.roomId;
            const activeChatId = $('[component="chat/main-wrapper"]').attr('data-roomid') || '';
            if (currentRoomId && String(currentRoomId) !== String(activeChatId)) {
                setTimeout(function() {
                    Chats.switchChat(currentRoomId);
                }, 100);
            } else {
                syncChatLoadedState();
            }

            bindAdminRecentChatsInfiniteScroll();
        });
    }

    // Keep the mobile layout state (body.chat-loaded / nav data-loaded) in sync with
    // the room that is actually rendered, without re-fetching it
    function syncChatLoadedState() {
        const activeChatId = parseInt($('[component="chat/main-wrapper"]').attr('data-roomid'), 10) || 0;
        $('body').toggleClass('chat-loaded', !!activeChatId);
        $('[component="chat/nav-wrapper"]').attr('data-loaded', activeChatId ? '1' : '0');
    }

    function replaceAdminEmptyStateText() {
        if (!hasAdminChatsAccess()) {
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
                $(this).text(t('empty.selectChat'));
                $(this).removeClass('text-muted');
            }
        });
    }

    function getChatWindows() {
        const windows = new Set($('[component="chat/message/window"]').toArray());
        $('.chat-modal').each(function() {
            const $modal = $(this);
            const nested = $modal.find('[component="chat/message/window"]').toArray();
            if (nested.length) {
                nested.forEach(el => windows.delete(el));
                windows.add(this);
            } else {
                windows.add(this);
            }
        });
        return $(Array.from(windows));
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

        // First, check if we have the room data in ajaxify.data (from the current page)
        const currentRoom = ajaxify && ajaxify.data && (ajaxify.data.room || ajaxify.data);
        if (currentRoom && parseInt(currentRoom.roomId, 10) === roomId) {
            if (currentRoom.adminChatLock) {
                setCachedRoomData(roomId, currentRoom);
                return currentRoom;
            }
        }

        // Check cache
        const cached = getCachedRoomData(roomId);
        if (cached) {
            return cached;
        }

        // Try admin endpoint first if user has access
        if (hasAdminChatsAccess()) {
            const adminEndpoint = `${config.relative_path || ''}/api/admin-chats/page/${roomId}`;
            try {
                const adminResponse = await fetch(adminEndpoint, {
                    headers: {
                        'x-csrf-token': config.csrf_token,
                    },
                    credentials: 'same-origin',
                });
                if (adminResponse.ok) {
                    const adminPayload = await adminResponse.json();
                    const adminRoom = adminPayload && adminPayload.roomId ? adminPayload : (adminPayload && adminPayload.room ? adminPayload.room : null);
                    if (adminRoom) {
                        setCachedRoomData(roomId, adminRoom);
                        return adminRoom;
                    }
                }
            } catch (err) {
                // Continue to fallback
            }
        }

        // For all users, try to get lock data from the new endpoint
        const lockEndpoint = `${config.relative_path || ''}/api/admin-chats/${roomId}/lock`;
        try {
            const lockResponse = await fetch(lockEndpoint, {
                headers: {
                    'x-csrf-token': config.csrf_token,
                },
                credentials: 'same-origin',
            });
            if (lockResponse.ok) {
                const lockPayload = await lockResponse.json();
                if (lockPayload && lockPayload.lockData) {
                    const roomData = {
                        roomId: roomId,
                        adminChatLock: lockPayload.lockData,
                    };
                    setCachedRoomData(roomId, roomData);
                    return roomData;
                }
            }
        } catch (err) {
            // Ignore error
        }

        return null;
    }
    function isLockedForUser(roomData) {
        return !!(roomData && roomData.adminChatLock && roomData.adminChatLock.isLocked && !canManageChats());
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
        target.prepend(`<div class="admin-chat-lock-banner alert alert-warning mb-2 text-start" style="${positionStyle} max-width: fit-content;">${t('lock.banner')}</div>`);
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

    function updateDeleteRestoreVisibility($window) {
        $window.find('[component="chat/message"]').each(function() {
            const $message = $(this);
            const isDeleted = $message.hasClass('deleted');
            $message.find('[data-action="delete"]').toggleClass('hidden', isDeleted).toggle(!isDeleted);
            $message.find('[data-action="restore"]').toggleClass('hidden', !isDeleted).toggle(isDeleted);
        });
    }

    function normalizeLockMessages($window) {
        $window.find('[component="chat/system-message"] > div').each(function() {
            const $el = $(this);
            const text = $el.text().trim();
            if (!text.includes(LOCK_PREFIX.slice(1, -1)) && !text.includes('admin-chat-lock')) {
                return;
            }
            $el.text(t('lock.banner'));
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

        if (!canManageChats() || !roomData || !roomData.roomId) {
            return;
        }

        const menus = getRoomMenuTargets($window);
        if (!menus.length) {
            return;
        }

        const lockData = roomData.adminChatLock || {};
        const isLocked = !!lockData.isLocked;
        const itemText = isLocked ? t('menu.release') : t('menu.lock');
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
        updateDeleteRestoreVisibility($window);
        renderLockBanner($window, hidden);
        renderAdminLockControl($window, roomData);
        normalizeLockMessages($window);
    }


    function getAdminRoomsMap() {
        const rooms = ajaxify && ajaxify.data && Array.isArray(ajaxify.data.rooms) ? ajaxify.data.rooms : [];
        return new Map(rooms.map(room => [String(room.roomId), room]));
    }

    function renderAdminParticipants() {
        if (!isAdminAllChatsPage()) {
            return;
        }

        const roomsMap = getAdminRoomsMap();
        $('[component="chat/recent/room"]').each(function() {
            const $room = $(this);
            const roomId = String($room.attr('data-roomid') || '');
            const roomData = roomsMap.get(roomId);
            const $container = $room.find('[component="chat/room/title"]').closest('.d-flex.flex-grow-1.flex-column.w-100');

            $container.find('.admin-chat-participants').remove();
            if (!$container.length || !roomData || !roomData.participantsLabel) {
                return;
            }

            const html = `<div class="admin-chat-participants text-muted text-xs text-break line-clamp-2"><span class="fw-semibold">${t('participants')}:</span> ${utils.escapeHTML(roomData.participantsLabel)}</div>`;
            $container.find('[component="chat/room/title"]').after(html);
        });
    }

    function applyAdminAllPageTweaks() {
        if (!isAdminAllChatsPage()) {
            return;
        }

        $('[component="chat/recent"] .mark-read').addClass('hidden');
        $('[data-action="leave"]').closest('li').addClass('hidden');
        renderAdminParticipants();
    }
    async function refreshChatUi() {
        replaceAdminEmptyStateText();
        applyAdminAllPageTweaks();
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

    async function injectProfileChatsMenu() {
        const allowed = await resolveAdminChatsAccess();
        if (!allowed) {
            return;
        }

        const isUserProfile = $(".account").length && window.location.pathname.includes("/user/");
        if (!isUserProfile) {
            return;
        }

        const userSlug = (ajaxify && ajaxify.data && (ajaxify.data.userslug || (ajaxify.data.user && ajaxify.data.user.userslug))) || null;
        if (!userSlug) {
            return;
        }

        const relativePath = config.relative_path || "";
        const menuItemHtml = `
            <li role="presentation" class="admin-chats-profile-link">
                <a class="dropdown-item rounded-1 d-flex align-items-center gap-2" href="${relativePath}/user/${userSlug}/chats" role="menuitem">
                    <i class="far fa-fw fa-comments"></i>
                    <span>${t("profile.viewChats")}</span>
                </a>
            </li>
        `;

        let menu = $(".account-sub-links");
        if (!menu.length) {
            const container = $(".account .flex-shrink-0.d-flex.gap-1").first();
            const fallbackContainer = container.length ? container : $(".account .flex-shrink-0").first();

            if (fallbackContainer.length) {
                const menuHtml = `
                    <div class="btn-group bottom-sheet admin-chats-privileges-menu">
                        <button type="button" class="btn btn-light dropdown-toggle" data-bs-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                            <i class="fa fa-gear fa-fw"></i>
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end p-1 text-sm account-sub-links" role="menu"></ul>
                    </div>
                `;
                fallbackContainer.append(menuHtml);
                menu = fallbackContainer.find(".account-sub-links").last();
            }
        }

        if (menu.length) {
            menu.find(".admin-chats-profile-link").remove();
            menu.find(".admin-chats-profile-divider").remove();
            menu.find(`a[href*="/user/${userSlug}/chats"]`).parent().remove();
            menu.prepend(menuItemHtml);

            const hasOtherItems = menu.find("li").not(".admin-chats-profile-link").length > 0;
            if (hasOtherItems) {
                menu.find(".admin-chats-profile-link").after('<li role="presentation" class="dropdown-divider admin-chats-profile-divider"></li>');
            }
        }
    }

    $(window).on('action:ajaxify.end', function(ev, data) {
        syncAdminAccessFromAjaxify();
        fetchAdminPrivileges();
        const templateName = ajaxify && ajaxify.data && ajaxify.data.template ? ajaxify.data.template.name : '';

        if (templateName.startsWith('account/')) {
            injectProfileChatsMenu();
            setTimeout(injectProfileChatsMenu, 200);
        }

        if (isAdminAllChatsPage()) {
            patchForumChatsForAdminAll();
            bindAdminRecentChatsInfiniteScroll();
            
            // Auto-open chat if roomId is specified in URL and that room is not already rendered
            const currentRoomId = ajaxify && ajaxify.data && ajaxify.data.roomId;
            const activeChatId = $('[component="chat/main-wrapper"]').attr('data-roomid') || '';
            if (currentRoomId && String(currentRoomId) !== String(activeChatId)) {
                setTimeout(function() {
                    require(['forum/chats'], function(Chats) {
                        if (Chats && Chats.switchChat) {
                            Chats.switchChat(currentRoomId);
                        }
                    });
                }, 200);
            } else {
                syncChatLoadedState();
            }
        }

        const url = data && data.url ? data.url : '';
        if (url.match(/^user\/.+\/chats/) || url.match(/^chats(\/|$)/)) {
            refreshChatUi();
            setTimeout(refreshChatUi, 500);
            setTimeout(refreshChatUi, 1200);
            
            // Handle chat navigation for internal URL changes
            if (url.match(/^chats\/\d+/)) {
                setTimeout(handleChatNavigation, 300);
            }
        }
    });

    $(window).on('action:chat.loaded', function() {
        if (isAdminAllChatsPage()) {
            patchForumChatsForAdminAll();
            bindAdminRecentChatsInfiniteScroll();
            
            // Auto-open chat if roomId is specified in URL and no chat is currently active
            const currentRoomId = ajaxify && ajaxify.data && ajaxify.data.roomId;
            const activeChatId = $('[component="chat/main-wrapper"]').attr('data-roomid');
            
            if (currentRoomId && (!activeChatId || activeChatId !== String(currentRoomId))) {
                setTimeout(function() {
                    require(['forum/chats'], function(Chats) {
                        if (Chats && Chats.switchChat) {
                            Chats.switchChat(currentRoomId);
                        }
                    });
                }, 100);
            } else {
                syncChatLoadedState();
            }
        }
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

    if (window.socket) {
        socket.removeListener('event:chats.delete', refreshChatUi);
        socket.removeListener('event:chats.restore', refreshChatUi);
        socket.on('event:chats.delete', function() { setTimeout(refreshChatUi, 0); });
        socket.on('event:chats.restore', function() { setTimeout(refreshChatUi, 0); });
    }

    // Monitor for new chat modals/windows being added to the DOM
    // This ensures styling is applied to floating chat windows opened from non-chat pages
    const observer = new MutationObserver(function(mutations) {
        let hasNewChatWindow = false;
        mutations.forEach(function(mutation) {
            if (mutation.type === 'childList') {
                mutation.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1) { // Element node
                        const $node = $(node);
                        if ($node.is('.chat-modal') || $node.find('.chat-modal').length) {
                            hasNewChatWindow = true;
                        }
                        if ($node.is('[component="chat/message/window"]') || $node.find('[component="chat/message/window"]').length) {
                            hasNewChatWindow = true;
                        }
                    }
                });
            }
        });
        if (hasNewChatWindow) {
            setTimeout(refreshChatUi, 50);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    // Handle browser back/forward navigation
    $(window).on('popstate', function() {
        if (isAdminAllChatsPage()) {
            setTimeout(handleChatNavigation, 100);
        }
    });

    // Handle URL changes for internal navigation (including back/forward gestures).
    // The URL is the source of truth here — ajaxify.data.roomId is stale after popstate.
    function handleChatNavigation() {
        if (!isAdminAllChatsPage()) {
            return;
        }

        const urlMatch = window.location.pathname.match(/\/chats\/(\d+)/);
        const urlRoomId = urlMatch ? parseInt(urlMatch[1], 10) : 0;
        const activeChatId = parseInt($('[component="chat/main-wrapper"]').attr('data-roomid'), 10) || 0;

        if (urlRoomId === activeChatId) {
            return;
        }

        require(['forum/chats'], function(Chats) {
            if (Chats && Chats.switchChat) {
                // urlRoomId 0 -> URL is the chat list: close the open chat and show the list
                // (previously a back-gesture out of a chat left the chat stuck on screen)
                Chats.switchChat(urlRoomId || '');
            }
        });
    }

    $(document).on('click', '[data-action="delete"], [data-action="restore"]', function() {
        const $window = $(this).closest('[component="chat/message/window"]');
        if (!$window.length) {
            return;
        }
        setTimeout(function() {
            updateDeleteRestoreVisibility($window);
        }, 50);
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
                currentRoom.canReply = !result.lockData.isLocked || canManageChats();
                currentRoom.showUserInput = currentRoom.canReply;
                if (ajaxify.data.room) {
                    ajaxify.data.room.adminChatLock = result.lockData;
                    ajaxify.data.room.canReply = currentRoom.canReply;
                    ajaxify.data.room.showUserInput = currentRoom.showUserInput;
                }
            }

            const cached = getCachedRoomData(roomId) || { roomId };
            cached.adminChatLock = result.lockData;
            cached.canReply = !result.lockData.isLocked || canManageChats();
            cached.showUserInput = cached.canReply;
            setCachedRoomData(roomId, cached);
            await refreshChatUi();
        } catch (err) {
            app.alertError(t('errors.update'));
            $button.removeClass('disabled').removeAttr('aria-disabled');
        }
    });

    // Intercept and translate error messages from API - only for lockedAction
    if (app.alertError && !app.alertError._adminChatsWrapped) {
        const originalAlertError = app.alertError;
        app.alertError = function(message) {
            if (typeof message === 'string') {
                if (message.includes('[[admin-chats:errors.lockedAction]]') || message.includes('errors.lockedAction')) {
                    message = getLockedActionMessage();
                }
            }
            return originalAlertError.call(this, message);
        };
        app.alertError._adminChatsWrapped = true;
    }
});

