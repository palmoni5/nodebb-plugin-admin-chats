'use strict';

// Core's chat list search (public/src/client/chats/search.js) always searches
// the caller's own rooms. On the admin all-chats page and on another user's
// chats page that lists the viewer's chats instead of the ones on screen, and
// opening one of them lands on /user/<other>/chats/<roomId> for a room that
// user is not in. Core binds its listener with no handle to remove it, so the
// input is swapped for a clone and searched through the plugin's endpoint.
$(document).ready(function () {
    function getSearchUid() {
        const data = ajaxify && ajaxify.data;
        if (!data) {
            return null;
        }
        if (data.adminAllChats) {
            return 0;
        }
        const uid = parseInt(data.uid, 10) || 0;
        if (!uid || uid === parseInt(app.user.uid, 10)) {
            return null;
        }
        return uid;
    }

    async function search(query, uid) {
        const params = new URLSearchParams({ query });
        if (uid) {
            params.set('uid', uid);
        }
        const response = await fetch(`${config.relative_path || ''}/api/admin-chats/search?${params.toString()}`, {
            credentials: 'same-origin',
        });
        if (!response.ok) {
            throw new Error(`Received ${response.status}`);
        }
        return await response.json();
    }

    function takeOverSearch() {
        const uid = getSearchUid();
        const searchEl = document.getElementById('search-chats');
        const listEl = document.getElementById('private-rooms');
        if (uid === null || !searchEl || !listEl || searchEl.hasAttribute('data-admin-chats-search')) {
            return;
        }

        const replacement = searchEl.cloneNode(true);
        replacement.value = searchEl.value;
        replacement.setAttribute('data-admin-chats-search', '1');
        searchEl.replaceWith(replacement);

        let lastQuery = replacement.value.trim();
        replacement.addEventListener('keyup', utils.debounce(async function () {
            const query = replacement.value.trim();
            if (query === lastQuery) {
                return;
            }
            lastQuery = query;
            try {
                const data = await search(query, uid);
                if (query !== lastQuery) {
                    return;
                }
                const html = await app.parseAndTranslate('chats', 'rooms', data);
                $(listEl).html(html);
                html.find('.timeago').timeago();
                listEl.setAttribute('data-nextstart', data.nextStart || 0);
                listEl.setAttribute('data-prevstart', 0);
                // Both infinite-scroll loaders (core's and switch-chat.js) bail out
                // while `loading` is set; keep them from appending the unfiltered
                // list under the search results.
                listEl.toggleAttribute('loading', !!query);
            } catch (err) {
                app.alertError(err);
            }
        }, 300));
    }

    $(window).on('action:chat.loaded', takeOverSearch);
});
