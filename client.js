$(document).ready(function() {
    
    function replaceAdminEmptyStateText() {
        if (!app.user.isAdmin) return;

        $('span.text-muted.text-sm').each(function() {
            const currentText = $(this).text().trim();
            if (currentText.includes("אין לכם צ'אטים פעילים") || currentText === "אין לכם צ'אטים פעילים.") {
                $(this).text("אנא בחר צ'אט מסרגל הצד.");
                $(this).removeClass('text-muted');
            }
        });
    }

    $(window).on('action:ajaxify.end', function(ev, data) {
        
        if (app.user.isAdmin && (data.tpl_url === 'account/profile' || ajaxify.data.template.name === 'account/profile')) {
            const userSlug = ajaxify.data.userslug || (ajaxify.data.user && ajaxify.data.user.userslug);
            if (userSlug) {
                const btnHtml = `
                    <li role="presentation">
                        <a class="dropdown-item rounded-1 d-flex align-items-center gap-2" href="/user/${userSlug}/chats" role="menuitem">
                            <i class="fa fa-fw fa-comments text-danger"></i> <span>צפה בצ'אטים</span>
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

        if (data.url.match(/^user\/.+\/chats/) || data.url === 'chats') {
            replaceAdminEmptyStateText();
            setTimeout(replaceAdminEmptyStateText, 500);
        }
    });

    $(window).on('action:chat.loaded', replaceAdminEmptyStateText);
    $(window).on('action:chat.closed', function() {
        setTimeout(replaceAdminEmptyStateText, 200);
    });
});
