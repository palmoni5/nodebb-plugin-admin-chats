'use strict';

const validator = nodebb.require('validator');
const Messaging = nodebb.require('./src/messaging');
const User = nodebb.require('./src/user');
const db = nodebb.require('./src/database');

function editHistoryKey(mid) {
    return `message:${mid}:editHistory`;
}

async function getMessageEditHistory(mid) {
    const [exists, current, rawHistory] = await Promise.all([
        Messaging.messageExists(mid),
        Messaging.getMessageFields(mid, ['content', 'fromuid', 'timestamp', 'edited', 'roomId', 'deleted']),
        db.getListRange(editHistoryKey(mid), 0, -1),
    ]);

    const revisions = (rawHistory || []).map((item) => {
        try {
            return JSON.parse(item);
        } catch (err) {
            return null;
        }
    }).filter(Boolean);

    const uidSet = new Set();
    const authorUid = parseInt(current && current.fromuid, 10) || 0;
    if (authorUid) {
        uidSet.add(authorUid);
    }
    revisions.forEach((rev) => {
        if (rev.editedByUid) {
            uidSet.add(parseInt(rev.editedByUid, 10) || 0);
        }
        if (rev.fromuid) {
            uidSet.add(parseInt(rev.fromuid, 10) || 0);
        }
    });
    uidSet.delete(0);

    const uids = [...uidSet];
    const userMap = new Map();
    if (uids.length) {
        const users = await User.getUsersFields(uids, ['uid', 'username', 'userslug']);
        uids.forEach((uid, index) => {
            if (users[index]) {
                userMap.set(uid, users[index]);
            }
        });
    }

    const decorate = (uid) => {
        const numeric = parseInt(uid, 10) || 0;
        const user = userMap.get(numeric);
        return {
            uid: numeric,
            username: user ? user.username : (numeric ? `uid ${numeric}` : '—'),
        };
    };

    return {
        mid,
        exists: !!exists,
        roomId: parseInt(current && current.roomId, 10) || 0,
        author: decorate(authorUid),
        current: {
            content: current ? String(current.content || '') : '',
            edited: parseInt(current && current.edited, 10) || 0,
            timestamp: parseInt(current && current.timestamp, 10) || 0,
            deleted: parseInt(current && current.deleted, 10) === 1,
        },
        revisionCount: revisions.length,
        revisions: revisions.map(rev => ({
            content: String(rev.content || ''),
            editor: decorate(rev.editedByUid),
            replacedAt: parseInt(rev.replacedAt, 10) || 0,
            previousEdited: parseInt(rev.previousEdited, 10) || 0,
        })),
    };
}

function renderMessageHistoryHtml(history) {
    const esc = value => validator.escape(String(value == null ? '' : value));
    const fmt = (ts) => {
        const numeric = parseInt(ts, 10) || 0;
        return numeric ? new Date(numeric).toISOString().replace('T', ' ').replace(/\..+$/, ' UTC') : '—';
    };

    if (!history.exists) {
        return `<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>היסטוריית עריכות</title><body style="font-family:system-ui,Arial,sans-serif;padding:2rem;">
            <h1>הודעה ${esc(history.mid)} לא נמצאה</h1></body></html>`;
    }

    const timeline = history.revisions.map((rev, index) => `
        <li class="rev">
            <div class="meta">גרסה ${index + 1} · הוחלפה ב-${esc(fmt(rev.replacedAt))} · עורך: ${esc(rev.editor.username)}</div>
            <pre class="content">${esc(rev.content)}</pre>
        </li>`).join('');

    const currentBlock = `
        <li class="rev current">
            <div class="meta">גרסה נוכחית${history.current.edited ? ` · נערכה לאחרונה ${esc(fmt(history.current.edited))}` : ''}${history.current.deleted ? ' · מחוקה' : ''}</div>
            <pre class="content">${esc(history.current.content)}</pre>
        </li>`;

    return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
<title>היסטוריית עריכות · הודעה ${esc(history.mid)}</title>
<style>
    body { font-family: system-ui, Segoe UI, Arial, sans-serif; margin: 0; padding: 2rem; background: #f5f6f8; color: #1c1e21; }
    h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
    .sub { color: #65676b; font-size: .875rem; margin-bottom: 1.5rem; }
    ul { list-style: none; margin: 0; padding: 0; max-width: 780px; }
    .rev { background: #fff; border: 1px solid #dcdfe3; border-radius: 8px; padding: .75rem 1rem; margin-bottom: 1rem; }
    .rev.current { border-color: #2d6cdf; box-shadow: 0 0 0 1px #2d6cdf33; }
    .meta { font-size: .8rem; color: #65676b; margin-bottom: .5rem; }
    .content { white-space: pre-wrap; word-break: break-word; margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
    @media (prefers-color-scheme: dark) {
        body { background: #18191a; color: #e4e6eb; }
        .rev { background: #242526; border-color: #3a3b3c; }
        .meta, .sub { color: #b0b3b8; }
    }
</style>
</head>
<body>
    <h1>היסטוריית עריכות · הודעה ${esc(history.mid)}</h1>
    <div class="sub">מחבר: ${esc(history.author.username)} · חדר: ${esc(history.roomId)} · ${esc(history.revisionCount)} עריכות קודמות</div>
    <ul>
        ${history.revisionCount ? timeline : '<li class="rev"><div class="meta">אין עריכות קודמות מתועדות</div></li>'}
        ${currentBlock}
    </ul>
</body>
</html>`;
}

module.exports = {
    editHistoryKey,
    getMessageEditHistory,
    renderMessageHistoryHtml,
};
