'use strict';

// The "View Chats" profile link has no server-side extension point: the
// account-menu dropdown (.account-sub-links) is a theme template
// (nodebb-theme-harmony: templates/partials/account/admin-menu.tpl) with a
// hardcoded item list and no hook firing over it, and it's only rendered at
// all when the viewer is a full admin or has ban/mute rights — not for a
// user who only holds the admin-chats privilege. So this has to be a
// client-side injection, unlike the chat UI (which does have real template
// override points — see templates/partials/chats/*.tpl).
$(document).ready(function () {
    function isAdminChatsAccessible() {
        return !!(ajaxify && ajaxify.data && ajaxify.data.adminChatsAccess);
    }

    async function resolveAdminChatsAccess() {
        if (isAdminChatsAccessible()) {
            return true;
        }
        try {
            const response = await fetch(`${config.relative_path || ''}/api/admin-chats?start=0`, {
                headers: { 'x-csrf-token': config.csrf_token },
                credentials: 'same-origin',
            });
            return response.ok;
        } catch (err) {
            return false;
        }
    }

    async function injectProfileChatsLink() {
        const isUserProfile = $('.account').length && window.location.pathname.includes('/user/');
        if (!isUserProfile || !await resolveAdminChatsAccess()) {
            return;
        }

        const userSlug = ajaxify && ajaxify.data && (ajaxify.data.userslug || (ajaxify.data.user && ajaxify.data.user.userslug));
        if (!userSlug) {
            return;
        }

        const relativePath = config.relative_path || '';
        // Injected via jQuery rather than a template, so [[...]] needs an
        // explicit translator call here — nothing else will resolve it.
        const label = await new Promise((resolve) => {
            require(['translator'], function (translator) {
                translator.translate('[[admin-chats:profile.viewChats]]', resolve);
            });
        });
        const menuItemHtml = `
            <li role="presentation" class="admin-chats-profile-link">
                <a class="dropdown-item rounded-1 d-flex align-items-center gap-2" href="${relativePath}/user/${userSlug}/chats" role="menuitem">
                    <i class="far fa-fw fa-comments"></i>
                    <span>${label}</span>
                </a>
            </li>
        `;

        let menu = $('.account-sub-links');
        if (!menu.length) {
            // No admin/ban/mute menu was rendered for this viewer (they only
            // hold the admin-chats privilege) — build a minimal dropdown of
            // our own next to the other profile action buttons.
            const container = $('.account .flex-shrink-0.d-flex.gap-1').first();
            const fallbackContainer = container.length ? container : $('.account .flex-shrink-0').first();

            if (fallbackContainer.length) {
                fallbackContainer.append(`
                    <div class="btn-group bottom-sheet admin-chats-privileges-menu">
                        <button type="button" class="btn btn-light dropdown-toggle" data-bs-toggle="dropdown" aria-haspopup="true" aria-expanded="false">
                            <i class="fa fa-gear fa-fw"></i>
                        </button>
                        <ul class="dropdown-menu dropdown-menu-end p-1 text-sm account-sub-links" role="menu"></ul>
                    </div>
                `);
                menu = fallbackContainer.find('.account-sub-links').last();
            }
        }

        if (!menu.length) {
            return;
        }

        menu.find('.admin-chats-profile-link, .admin-chats-profile-divider').remove();
        menu.prepend(menuItemHtml);

        if (menu.find('li').not('.admin-chats-profile-link').length > 0) {
            menu.find('.admin-chats-profile-link').after('<li role="presentation" class="dropdown-divider admin-chats-profile-divider"></li>');
        }
    }

    $(window).on('action:ajaxify.end', function (ev, data) {
        const templateName = ajaxify && ajaxify.data && ajaxify.data.template ? ajaxify.data.template.name : '';
        if (templateName.startsWith('account/')) {
            injectProfileChatsLink();
        }
    });
});
