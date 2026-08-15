'use strict';

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

    // The author of the current version is whoever performed the most recent
    // edit (the newest revision's editor); with no revisions it's the sender.
    const lastRevision = revisions[revisions.length - 1];

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
            editor: decorate(lastRevision ? lastRevision.editedByUid : authorUid),
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

async function deleteRevision(mid, index) {
    const key = editHistoryKey(mid);
    const items = await db.getListRange(key, 0, -1);
    const numericIndex = parseInt(index, 10);

    if (!Array.isArray(items) || Number.isNaN(numericIndex) || numericIndex < 0 || numericIndex >= items.length) {
        return false;
    }

    items.splice(numericIndex, 1);
    await db.delete(key);
    for (const item of items) {
        // eslint-disable-next-line no-await-in-loop
        await db.listAppend(key, item);
    }

    return true;
}

module.exports = {
    editHistoryKey,
    getMessageEditHistory,
    deleteRevision,
};
