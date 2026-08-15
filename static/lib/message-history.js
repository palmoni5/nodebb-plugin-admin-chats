'use strict';

// "Edit history" item in the chat message options dropdown (rendered
// server-side in templates/partials/chats/message.tpl, gated on manage
// privilege via isAdminOrGlobalMod). Opens a modal modelled on core's post
// diffs modal (public/src/client/topic/diffs.js): a revision selector, the
// selected revision's content, and a delete-revision button. The API routes
// it calls are manage-only as well, so the client gating is cosmetic.
$(document).ready(function () {
    const localeStringOpts = { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: 'numeric' };

    function prettyDate(timestamp) {
        const numeric = parseInt(timestamp, 10) || 0;
        if (!numeric) {
            return '—';
        }
        return new Date(numeric).toLocaleString((config.userLang || 'en-GB').replace('_', '-'), localeStringOpts);
    }

    async function requestHistory(mid, method, revisionIndex) {
        const suffix = (method === 'DELETE' || method === 'PUT') ? `/${revisionIndex}` : '';
        const response = await fetch(`${config.relative_path || ''}/api/admin-chats/history/${mid}${suffix}`, {
            method: method || 'GET',
            headers: { 'x-csrf-token': config.csrf_token },
            credentials: 'same-origin',
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error((data && data.status && data.status.message) || 'Request failed');
        }

        return data;
    }

    // The selector lists the current version first, then prior revisions
    // newest-first. Option values keep the revision's index in the stored
    // (oldest-first) list so deletes address the right entry.
    function buildEntries(history, labels) {
        const currentEditor = (history.current.editor && history.current.editor.username) ||
            (history.author && history.author.username) || '';
        const entries = [{
            value: 'current',
            label: `${prettyDate(history.current.edited || history.current.timestamp)} [${currentEditor}] · ${labels.current}`,
            content: history.current.content,
        }];

        history.revisions.forEach((revision, index) => {
            entries.push({
                value: String(index),
                label: `${prettyDate(revision.replacedAt)} [${revision.editor.username}]`,
                content: revision.content,
            });
        });

        return [entries[0]].concat(entries.slice(1).reverse());
    }

    function renderState($modal, history, labels) {
        const $select = $modal.find('select');
        const $content = $modal.find('.admin-chat-history-content');
        const $deleteBtn = $modal.find('[data-action="delete-revision"]');
        const $restoreBtn = $modal.find('[data-action="restore-revision"]');
        const $count = $modal.find('.admin-chat-history-count');

        const entries = buildEntries(history, labels);
        const contentByValue = new Map(entries.map(entry => [entry.value, entry.content]));

        $select.empty();
        entries.forEach((entry) => {
            const option = document.createElement('option');
            option.value = entry.value;
            option.textContent = entry.label;
            $select.append(option);
        });

        $count.text(labels.count.replace('%1', String(history.revisionCount)));

        const showSelection = () => {
            const value = $select.val();
            $content.text(contentByValue.get(value) || '');
            $deleteBtn.prop('disabled', value === 'current');
            $restoreBtn.prop('disabled', value === 'current');
        };

        $select.off('change').on('change', showSelection);
        showSelection();
    }

    async function openHistoryModal(mid, modals, alerts, translator) {
        const history = await requestHistory(mid);

        const labels = {
            current: await translator.translate('[[admin-chats:history.current]]'),
            count: await translator.translate('[[admin-chats:history.revisionCount, %1]]'),
        };

        // modals.dialog runs the message through the translator itself
        const $modal = await modals.dialog({
            title: '[[admin-chats:history.title]]',
            message: '<p class="admin-chat-history-count text-muted"></p>' +
                '<div class="mb-3">' +
                '<select class="form-control"></select>' +
                '<hr />' +
                '<pre class="admin-chat-history-content text-break mb-3" style="white-space: pre-wrap;"></pre>' +
                '<button class="btn btn-primary" data-action="restore-revision">[[admin-chats:history.restore]]</button> ' +
                '<button class="btn btn-danger" data-action="delete-revision">[[admin-chats:history.deleteRevision]]</button>' +
                '<p class="form-text">[[admin-chats:history.restoreDescription]]</p>' +
                '</div>',
            size: 'large',
            onEscape: true,
            backdrop: true,
        });

        renderState($modal, history, labels);

        $modal.find('[data-action="restore-revision"]').on('click', async function () {
            const value = $modal.find('select').val();
            if (value === 'current') {
                return;
            }

            try {
                await requestHistory(mid, 'PUT', value);
                $modal.modal('hide');
                alerts.success('[[admin-chats:history.restored]]');
            } catch (err) {
                alerts.error('[[admin-chats:errors.history]]');
            }
        });

        $modal.find('[data-action="delete-revision"]').on('click', function () {
            const value = $modal.find('select').val();
            if (value === 'current') {
                return;
            }

            modals.confirm('[[admin-chats:history.confirmDelete]]', async (confirmed) => {
                if (!confirmed) {
                    return;
                }

                try {
                    const fresh = await requestHistory(mid, 'DELETE', value);
                    renderState($modal, fresh, labels);
                    alerts.success('[[admin-chats:history.deleted]]');
                } catch (err) {
                    alerts.error('[[admin-chats:errors.history]]');
                }
            });
        });
    }

    // Messages rendered live on the client (incoming messages, and a message
    // re-parsed right after an edit) go through core's parseMessage, which
    // sets isAdminOrGlobalMod = app.user.isAdmin || app.user.isGlobalMod —
    // ignoring the plugin's manage privilege that gates the server-rendered
    // item. Re-add the item on dropdown open when the room payload grants
    // management and the item is missing.
    $(document).on('show.bs.dropdown', '[component="chat/message"] .btn-group', function () {
        if (!ajaxify.data || !ajaxify.data.isAdminOrGlobalMod) {
            return;
        }

        const $menu = $(this).find('.dropdown-menu');
        if (!$menu.length || $menu.find('.admin-chat-history-item').length) {
            return;
        }

        const $message = $(this).closest('[component="chat/message"]');
        const mid = parseInt($message.attr('data-mid'), 10);
        if (!mid) {
            return;
        }

        // Same gate as the server-rendered item: only edited messages have a
        // history to show. The edited indicator element exists on every
        // message and carries `hidden` while the message is unedited.
        const $edited = $message.find('[component="chat/message/edited"]');
        if (!$edited.length || $edited.hasClass('hidden')) {
            return;
        }

        require(['translator'], function (translator) {
            translator.translate('[[admin-chats:history.title]]', function (title) {
                if ($menu.find('.admin-chat-history-item').length) {
                    return;
                }

                const $item = $(
                    '<li><a href="#" class="dropdown-item rounded-1 admin-chat-history-item" role="menuitem">' +
                    '<span class="d-inline-flex align-items-center gap-2"><i class="fa fa-fw fa-history text-muted"></i> </span></a></li>'
                );
                $item.find('a').attr('data-mid', String(mid));
                $item.find('span').append(document.createTextNode(title));

                const $copyText = $menu.find('[data-action="copy-text"]').closest('li');
                if ($copyText.length) {
                    $item.insertBefore($copyText);
                } else {
                    $menu.append($item);
                }
            });
        });
    });

    $(document).on('click', '.admin-chat-history-item', function (ev) {
        ev.preventDefault();

        const mid = parseInt($(this).attr('data-mid'), 10);
        if (!mid) {
            return;
        }

        require(['modals', 'alerts', 'translator'], function (modals, alerts, translator) {
            openHistoryModal(mid, modals, alerts, translator).catch(() => {
                alerts.error('[[admin-chats:errors.history]]');
            });
        });
    });
});
