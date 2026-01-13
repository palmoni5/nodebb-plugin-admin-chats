'use strict';

const plugin = {};

plugin.init = async function (params) {
    // אין צורך בנתיבים מותאמים אישית יותר
    console.log('[Admin Chats] Plugin loaded (Link Only Mode).');
};

plugin.addProfileLink = async function (data) {
    // הוספת הקישור ברמת השרת (למקרה שה-Client JS לא נטען או לבוטים)
    try {
        const userSlug = data.user ? data.user.userslug : (data.userData ? data.userData.userslug : null);
        
        if (userSlug) {
            data.links.push({
                id: 'admin-view-chats',
                route: 'user/' + userSlug + '/chats', // הקישור המקורי של NodeBB
                icon: 'fa-comments',
                name: 'צפה בצ\'אטים',
                visibility: {
                    self: false,
                    other: true,
                    moderator: false,
                    globalMod: false,
                    admin: true,
                }
            });
        }
    } catch (e) {
        console.error('[Admin Chats] Error adding profile link:', e);
    }
    return data;
};

module.exports = plugin;