'use strict';

// Admin-all-chats room routing. Core has no hook for intercepting
// Chats.switchChat, and the admin page uses a different URL scheme
// (/chats/:roomId vs /user/:slug/chats/:roomId) than a regular user's chat
// page, so wrapping the whole function is still the only way to route room
// switches through the admin API endpoints instead of core's.
$(document).ready(function () {
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
                headers: { 'x-csrf-token': config.csrf_token },
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

        $('[component="chat/recent"]').off('scroll').on('scroll', utils.debounce(function () {
            const $this = $(this);
            const bottom = ($this[0].scrollHeight - $this.height()) * 0.9;
            if ($this.scrollTop() > bottom) {
                loadMoreAdminChats();
            }
        }, 100));
    }

    // Keep the mobile layout state (body.chat-loaded / nav data-loaded) in sync with
    // the room that is actually rendered, without re-fetching it
    function syncChatLoadedState() {
        const activeChatId = parseInt($('[component="chat/main-wrapper"]').attr('data-roomid'), 10) || 0;
        $('body').toggleClass('chat-loaded', !!activeChatId);
        $('[component="chat/nav-wrapper"]').attr('data-loaded', activeChatId ? '1' : '0');
    }

    function openRoomIfUrlDiffers(delay) {
        const currentRoomId = ajaxify && ajaxify.data && ajaxify.data.roomId;
        const activeChatId = $('[component="chat/main-wrapper"]').attr('data-roomid') || '';
        if (currentRoomId && String(currentRoomId) !== String(activeChatId)) {
            setTimeout(function () {
                require(['forum/chats'], function (Chats) {
                    if (Chats && Chats.switchChat) {
                        Chats.switchChat(currentRoomId);
                    }
                });
            }, delay);
        } else {
            syncChatLoadedState();
        }
    }

    function patchForumChatsForAdminAll() {
        if (!isAdminAllChatsPage()) {
            return;
        }

        require(['forum/chats', 'forum/chats/messages'], function (Chats, ChatsMessages) {
            if (!Chats || Chats._adminAllChatsPatched) {
                if (Chats) {
                    openRoomIfUrlDiffers(100);
                    bindAdminRecentChatsInfiniteScroll();
                }
                return;
            }

            const originalSwitchChat = Chats.switchChat;

            Chats.switchChat = function (roomId) {
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

                async function renderAdminChatWindow(payload) {
                    const html = await app.parseAndTranslate('partials/chats/message-window', payload);
                    const mainWrapper = $('[component="chat/main-wrapper"]');
                    mainWrapper.html(html);
                    mainWrapper.attr('data-roomid', roomId);
                    html.find('.timeago').timeago();
                    ajaxify.data = { ...ajaxify.data, ...payload, roomId: roomId };
                    ajaxify.updateTitle(ajaxify.data.title);
                    $('body').toggleClass('chat-loaded', !!roomId);
                    $('[component="chat/nav-wrapper"]').attr('data-loaded', roomId ? '1' : '0');
                    mainWrapper.find('[data-bs-toggle="tooltip"]').tooltip({ trigger: 'hover', container: '#content' });
                    Chats.setActive(roomId);
                    Chats.addEventListeners();
                    // Fire through the hooks module like core does — a raw jQuery
                    // trigger never reaches hooks.on() listeners (e.g. the reactions
                    // plugin), only legacy $(window).on() ones (e.g. the emoji plugin).
                    require(['hooks'], function (hooks) {
                        hooks.fire('action:chat.loaded', $('.chats-full'));
                    });
                    if (roomId) {
                        ChatsMessages.scrollToBottomAfterImageLoad(mainWrapper.find('[component="chat/message/content"]'));
                        // Read-state is cleared server-side when the room payload is
                        // built; just keep the list UI in sync
                        $('[component="chat/nav-wrapper"]').find(`[data-roomid="${roomId}"]`).removeClass('unread');
                    }
                    if (history.pushState) {
                        const fullUrl = `${window.location.protocol}//${window.location.host}${config.relative_path || ''}/${url}`;
                        // When the address bar already shows the target (e.g. closing a chat
                        // after a back-gesture), replace instead of stacking a duplicate entry
                        const sameUrl = window.location.href.split('?')[0] === fullUrl.split('?')[0];
                        history[sameUrl ? 'replaceState' : 'pushState']({ url: url }, null, fullUrl);
                    }
                    bindAdminRecentChatsInfiniteScroll();
                }

                if (!roomId) {
                    // Closing a chat needs no server round-trip — render the empty
                    // window from the data we already have (instant back-gesture)
                    renderAdminChatWindow({ ...ajaxify.data, roomId: 0, title: '[[pages:chats]]' });
                    return;
                }

                fetch(getAdminChatsDataUrl(roomId), { credentials: 'include' })
                    .then(async function (response) {
                        if (!response.ok) {
                            throw new Error(`Received ${response.status}`);
                        }
                        await renderAdminChatWindow(await response.json());
                    })
                    .catch(function () {
                        // Never leave the user stuck on the list — fall back to a
                        // regular ajaxify navigation to the room
                        ajaxify.go(url);
                    });
            };

            Chats._adminAllChatsPatched = true;

            openRoomIfUrlDiffers(100);
            bindAdminRecentChatsInfiniteScroll();
        });
    }

    // Handle browser back/forward navigation. The URL is the source of truth
    // here — ajaxify.data.roomId is stale after popstate.
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

        require(['forum/chats'], function (Chats) {
            if (Chats && Chats.switchChat) {
                // urlRoomId 0 -> URL is the chat list: close the open chat and show the list
                Chats.switchChat(urlRoomId || '');
            }
        });
    }

    $(window).on('action:ajaxify.end', function (ev, data) {
        if (isAdminAllChatsPage()) {
            patchForumChatsForAdminAll();

            const url = data && data.url ? data.url : '';
            if (url.match(/^chats\/\d+/)) {
                setTimeout(handleChatNavigation, 300);
            }
        }
    });

    $(window).on('action:chat.loaded', function () {
        if (isAdminAllChatsPage()) {
            patchForumChatsForAdminAll();
        }
    });

    $(window).on('popstate', function () {
        if (isAdminAllChatsPage()) {
            setTimeout(handleChatNavigation, 100);
        }
    });
});
