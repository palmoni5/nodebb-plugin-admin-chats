'use strict';
const User = require.main.require('./src/user');
const Messaging = require.main.require('./src/messaging');
const plugin = {};

// Hook: מאשר גישה אם המבקש הוא אדמין
plugin.allowAdminAccess = async function (data) {
    const isAdmin = await User.isAdministrator(data.callerUid);
    if (isAdmin) {
        data.canGet = true; // דורס את ברירת המחדל
    }
    return data;
};

plugin.init = async function (params) {
    const router = params.router;
    const middleware = params.middleware;

    // --- נתיב 1: רשימת החדרים ---
    router.get('/user-chats-viewer/:targetUid', middleware.ensureLoggedIn, async (req, res) => {
        try {
            const isAdmin = await User.isAdministrator(req.uid);
            if (!isAdmin) return res.status(403).send('Access Denied');

            const targetUid = req.params.targetUid;
            const userData = await User.getUserFields(targetUid, ['username']);
            const username = userData.username || 'User ' + targetUid;

            // שימוש ב-targetUid כבעל הצ'אטים
            const result = await Messaging.getRecentChats(req.uid, targetUid, 0, 49);
            const roomsData = result.rooms || result || []; 
            
            let html = getBaseHtml(`צ'אטים של ${username}`);
            html += `
            <div class="container mt-4">
                <div class="d-flex justify-content-between align-items-center mb-4 p-3 bg-white rounded shadow-sm border">
                    <div>
                        <h4 class="mb-0 text-primary">צ'אטים של <strong>${username}</strong></h4>
                        <small class="text-muted">UID: ${targetUid} | ${roomsData.length} שיחות</small>
                    </div>
                </div>
                <div class="row">`;

            if (!roomsData.length) html += '<div class="alert alert-warning">לא נמצאו שיחות.</div>';

            roomsData.forEach(room => {
                let content = room.teaser ? (room.teaser.content || '(מדיה)') : '(ריק)';
                content = content.replace(/</g, "&lt;").replace(/>/g, "&gt;");
                let dateStr = room.teaser ? new Date(room.teaser.timestamp).toLocaleString('he-IL') : '';

                html += `
                <div class="col-12 col-md-6 mb-3">
                    <div class="card shadow-sm h-100">
                        <div class="card-header d-flex justify-content-between">
                            <strong>חדר #${room.roomId}</strong>
                            <span style="font-size:0.8em">${dateStr}</span>
                        </div>
                        <div class="card-body">
                            <p class="text-muted text-truncate">${content}</p>
                            <a href="/user-chats-viewer/room/${room.roomId}" class="btn btn-primary btn-sm w-100">
                                <i class="fa fa-eye"></i> צפה בתוכן השיחה
                            </a>
                        </div>
                    </div>
                </div>`;
            });
            html += '</div></div></body></html>';
            res.send(html);

        } catch (err) { res.status(500).send("Error: " + err.message); }
    });

    // --- נתיב 2: צפייה בתוכן חדר (התיקון כאן) ---
    router.get('/user-chats-viewer/room/:roomId', middleware.ensureLoggedIn, async (req, res) => {
        try {
            const isAdmin = await User.isAdministrator(req.uid);
            if (!isAdmin) return res.status(403).send('Access Denied');

            const roomId = req.params.roomId;

            // 1. קודם כל נבדוק מי נמצא בחדר
            const uidsInRoom = await Messaging.getUidsInRoom(roomId, 0, -1);
            
            // 2. נבחר משתמש "פונדקאי" (Proxy) שיש לו גישה להודעות
            // אם המנהל בפנים - נשתמש בו. אם לא, ניקח את המשתמש הראשון ברשימה.
            let proxyUid = req.uid;
            if (!uidsInRoom.includes(String(req.uid)) && uidsInRoom.length > 0) {
                proxyUid = uidsInRoom[0];
            }

            // 3. שליפת הודעות באמצעות ה-Proxy UID
            // (ה-Hook שלנו יאשר את הפעולה כי callerUid הוא עדיין האדמין)
            const messages = await Messaging.getMessages({
                callerUid: req.uid, // האדמין מבקש (כדי לעבור אבטחה ב-Hook)
                roomId: roomId,
                uid: proxyUid,      // המערכת חושבת שזה עבור המשתמש הזה (כדי לחשב זמני הצטרפות)
                count: 100
            });
            
            // שליפת פרטי המשתתפים לתצוגה
            const usersData = await User.getUsersFields(uidsInRoom, ['uid', 'username', 'picture']);
            const userMap = {};
            usersData.forEach(u => userMap[u.uid] = u);

            let html = getBaseHtml(`חדר #${roomId}`);
            html += `
            <div class="container mt-4">
                <div class="mb-3">
                    <a href="javascript:history.back()" class="btn btn-outline-secondary">&larr; חזרה לרשימה</a>
                    <span class="mx-2 fw-bold">חדר #${roomId} (צפייה דרך UID: ${proxyUid})</span>
                </div>
                <div class="chat-container bg-white border rounded p-3" style="max-height: 80vh; overflow-y: auto;">
            `;

            if (!messages || !messages.length) {
                html += '<div class="text-center text-muted p-5">אין הודעות בחדר זה (או שלא ניתן לשחזר היסטוריה).</div>';
            } else {
                // היפוך סדר ההודעות
                messages.reverse().forEach(msg => {
                    const u = userMap[msg.fromuid] || { username: 'Unknown', picture: '' };
                    const date = new Date(msg.timestamp).toLocaleString('he-IL');
                    const content = msg.content; 

                    html += `
                    <div class="d-flex mb-3 border-bottom pb-2">
                        <div class="flex-shrink-0 ms-2">
                            ${u.picture ? `<img src="${u.picture}" class="rounded-circle" width="40" height="40">` : `<div class="rounded-circle bg-secondary text-white d-flex align-items-center justify-content-center" style="width:40px;height:40px;">${u.username[0]}</div>`}
                        </div>
                        <div class="flex-grow-1">
                            <div class="d-flex justify-content-between">
                                <strong>${u.username} <small class="text-muted fw-normal">(UID: ${msg.fromuid})</small></strong>
                                <small class="text-muted">${date}</small>
                            </div>
                            <div class="mt-1" style="font-size: 1.1em; white-space: pre-wrap;">${content}</div>
                        </div>
                    </div>`;
                });
            }

            html += '</div></div></body></html>';
            res.send(html);

        } catch (err) { 
            console.error(err);
            res.status(500).send("Error reading room: " + err.message); 
        }
    });
};

function getBaseHtml(title) {
    return `
    <!DOCTYPE html>
    <html lang="he" dir="rtl">
    <head>
        <meta charset="UTF-8">
        <title>${title}</title>
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.rtl.min.css">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
        <style>
            body { background-color: #f0f2f5; font-family: system-ui, -apple-system, sans-serif; }
            a { text-decoration: none; }
        </style>
    </head>
    <body>`;
}

plugin.addProfileLink = async function (data) {
    try {
        let targetUid;
        if (data.uid) targetUid = data.uid;
        else if (data.user && data.user.uid) targetUid = data.user.uid;
        if (!targetUid) return data;

        data.links.push({
            id: 'admin-view-chats',
            route: '/user-chats-viewer/' + targetUid,
            icon: 'fa-comments',
            name: 'View Chats (Admin)',
            visibility: { other: true, admin: true }
        });
    } catch (e) { }
    return data;
};

module.exports = plugin;