$(document).ready(function() {
    $(window).on('action:ajaxify.end', function(ev, data) {
        
        // בדיקה שאנחנו בפרופיל ובדיקה שאנחנו אדמין
        if ((data.tpl_url !== 'account/profile' && ajaxify.data.template.name !== 'account/profile') || !app.user.isAdmin) {
            return;
        }

        const targetUid = ajaxify.data.uid || ajaxify.data.user.uid;
        console.log('[Admin Chats Plugin] Injecting button for UID:', targetUid);

        // שינוי הקישור לנתיב החדש: /user-chats-viewer/
        // הוספנו target="_blank" כדי שייפתח בטאב חדש נקי
        const btnHtml = `
            <li role="presentation">
                <a class="dropdown-item rounded-1 d-flex align-items-center gap-2" href="/user/${targetUid}/chats" role="menuitem">
                    <i class="fa fa-fw fa-eye text-danger"></i> <span>צפה בצ'אטים)</span>
                </a>
            </li>
            <li role="presentation" class="dropdown-divider"></li>
        `;

        const menu = $('.account-sub-links');
        if (menu.length) {
            // מונע כפילות כפתורים אם עוברים מהר בין דפים
            menu.find('a[href*="/user-chats-viewer/"]').parent().remove();
            menu.prepend(btnHtml);
        }
    });
});
